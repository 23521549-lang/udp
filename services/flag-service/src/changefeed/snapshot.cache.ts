import type { PrismaClient, SdkKeyType } from "@udp/db";
import type { Snapshot } from "@udp/flag-evaluator";
import { snapshotFromRow } from "../evaluation/snapshot-builder.js";
import { snapshotRowOf } from "../evaluation/snapshot-row.js";

/**
 * Cache snapshot theo `(environmentId, keyType)` — biện pháp BẮT BUỘC của ADR-05.
 *
 * "Không có nó, 500 SDK cùng phát hiện thay đổi trong cửa sổ 500ms sẽ tạo 500
 * truy vấn; có nó thì đúng MỘT truy vấn." Đã đo hình dạng đó trên database thật:
 * 50 lời gọi đồng thời trên pool 5 làm 26/50 chết bằng `P2028`, nên "500 truy
 * vấn" không phải chậm hơn — phần tràn ra là hỏng hẳn.
 */

/**
 * Một mục cache là BỘ BA BẤT BIẾN, không phải ba trường rời có thể lệch pha.
 *
 * Đây là chỗ sửa lỗi nặng nhất của bản plan đầu, và nó tái hiện được: phục vụ
 * `/sdk/config` bằng cách đọc version rồi đọc snapshot ở hai câu lệnh rời cho ra
 * **snapshot CŨ dưới ETag MỚI**. SDK cache đúng cặp đó, mọi lần poll sau gửi
 * `If-None-Match` khớp và nhận **304 vĩnh viễn** — flag đứng nguyên cho tới khi
 * một thay đổi không liên quan đẩy version lên. Cache của chính flag-service giữ
 * cặp nhiễm độc ấy và phục vụ nó cho MỌI SDK trên replica đó.
 *
 * Nên ba trường này chỉ được sinh ra cùng nhau, từ một lần đọc nhất quán, và
 * không bao giờ được cập nhật lẻ. Trong khe "đã biết có version mới nhưng chưa
 * dựng xong snapshot mới", câu trả lời đúng là **giữ nguyên cả bộ ba cũ** —
 * chậm thì được, lệch thì không.
 */
export interface ConfigEntry {
  readonly environmentId: string;
  readonly keyType: SdkKeyType;
  /** Tên environment cho `SdkConfigResponse.environment`. KHÔNG nằm trong hash */
  readonly environmentName: string;
  readonly configVersion: number;
  readonly configHash: string;
  readonly snapshot: Snapshot;
}

export type EntryLoader = (
  environmentId: string,
) => Promise<Omit<ConfigEntry, "keyType">>;

export interface SnapshotCache {
  /** Lấy từ cache, nạp nếu chưa có. Nhiều lời gọi cùng lúc gộp thành MỘT lần nạp */
  get(environmentId: string, keyType: SdkKeyType): Promise<ConfigEntry>;
  /** Ép nạp lại — đường rơi tầng của ADR-05 */
  reload(environmentId: string, keyType: SdkKeyType): Promise<ConfigEntry>;
  /** Đọc không nạp. Watcher dùng nó để biết con trỏ hiện tại */
  peek(environmentId: string, keyType: SdkKeyType): ConfigEntry | undefined;
  /** Thay bộ ba sau khi áp delta thành công */
  put(entry: ConfigEntry): void;
  /** Những gì đang được giữ — tập environment mà watcher cần poll */
  tracked(): ConfigEntry[];
  /**
   * Replica này có đang giữ — hoặc đang NẠP — environment này không.
   *
   * Tầng 3 dùng để bỏ qua notice của environment mà không ai trên replica này đọc:
   * mọi lần ghi trên mọi project đều phát trên cùng một kênh. Tính cả lần nạp đang
   * bay, vì notice tới đúng lúc SDK đầu tiên vừa nối vẫn phải đánh thức.
   */
  holds(environmentId: string): boolean;
  clear(): void;
}

export function createSnapshotCache(load: EntryLoader): SnapshotCache {
  const entries = new Map<string, ConfigEntry>();
  const inflight = new Map<string, Promise<ConfigEntry>>();

  const keyOf = (environmentId: string, keyType: SdkKeyType): string =>
    `${environmentId}:${keyType}`;

  /**
   * Single-flight: N người gọi cùng lúc chỉ tạo MỘT lần đọc database.
   *
   * Hai chi tiết mà làm sai là hỏng theo hai kiểu ngược nhau:
   *
   * - **Xoá khỏi `inflight` ở `finally`, không phải `then`.** Chỉ xoá khi thành
   *   công thì một lần nạp lỗi để lại một promise đã reject nằm mãi trong map,
   *   và mọi người gọi sau `await` đúng cái promise đó — environment ấy hỏng
   *   vĩnh viễn cho tới lúc restart.
   * - **`set` phải nằm sau khi đã dựng chuỗi, và đồng bộ.** Nhả ra một nhịp giữa
   *   hai việc là mở lại đúng cơn bão mà hàm này sinh ra để chặn.
   */
  const loadOnce = (
    environmentId: string,
    keyType: SdkKeyType,
  ): Promise<ConfigEntry> => {
    const key = keyOf(environmentId, keyType);
    const existing = inflight.get(key);
    if (existing !== undefined) return existing;

    const started = load(environmentId)
      .then((base) => {
        const entry: ConfigEntry = { ...base, keyType };
        entries.set(key, entry);
        return entry;
      })
      .finally(() => {
        inflight.delete(key);
      });

    inflight.set(key, started);
    return started;
  };

  return {
    get(environmentId, keyType) {
      const cached = entries.get(keyOf(environmentId, keyType));
      if (cached !== undefined) return Promise.resolve(cached);
      return loadOnce(environmentId, keyType);
    },

    reload: loadOnce,

    peek(environmentId, keyType) {
      return entries.get(keyOf(environmentId, keyType));
    },

    put(entry) {
      entries.set(keyOf(entry.environmentId, entry.keyType), entry);
    },

    tracked() {
      return [...entries.values()];
    },

    holds(environmentId) {
      const prefix = `${environmentId}:`;
      for (const key of entries.keys()) if (key.startsWith(prefix)) return true;
      for (const key of inflight.keys())
        if (key.startsWith(prefix)) return true;
      return false;
    },

    clear() {
      entries.clear();
      inflight.clear();
    },
  };
}

/**
 * Đọc `(version, hash, snapshot)` của một environment trong MỘT ảnh chụp — bằng
 * MỘT câu lệnh SQL.
 *
 * Lịch sử của chỗ này là lịch sử của một bug: bản đầu đọc version rồi đọc
 * snapshot ở hai câu lệnh rời, một lần ghi chen vào giữa cho ra **snapshot CŨ
 * dưới ETag MỚI** (xem `ConfigEntry`). Bản hai gói hai câu vào một transaction
 * `RepeatableRead` — đúng, nhưng tốn 9 truy vấn và một transaction cho mỗi lần
 * nạp, và cùng đường ấy chạy dưới row-lock của mọi lần ghi. Bản này đọc tất cả
 * trong một `SELECT`: PostgreSQL cho một câu lệnh thấy đúng một ảnh chụp
 * (§13.2.1 của tài liệu 17, trích ở `snapshot-row.ts`), nên bộ ba cùng khoảnh
 * khắc bằng cấu trúc — mạnh hơn `RepeatableRead` vì không còn khe nào để đặt
 * sai mức cô lập.
 *
 * Ngân sách chờ pool (`maxWait` của transaction cũ) không mất đi: nó chuyển
 * xuống tầng adapter cho MỌI truy vấn của MỌI service (`DB_POOL.acquireTimeoutMs`
 * trong `@udp/config/constants`), và `dbAvailabilityError` dịch nó thành 503 —
 * xem `packages/db/src/adapter.ts`.
 *
 * Environment không tồn tại thì ném `Error` thường: watcher đã bỏ qua environment
 * biến mất TRƯỚC khi nạp lại, còn `/sdk/config` và SSE đẩy lỗi lên error-handler
 * thành 500 — không ai phân nhánh theo lớp lỗi ở đây.
 */
export function prismaEntryLoader(client: PrismaClient): EntryLoader {
  return async (environmentId) => {
    const row = await snapshotRowOf(client, environmentId);
    if (row === undefined) {
      throw new Error(
        `Environment ${environmentId} không tồn tại — không nạp được cấu hình`,
      );
    }
    return {
      environmentId,
      environmentName: row.name,
      configVersion: row.configVersion,
      configHash: row.configHash,
      snapshot: snapshotFromRow(row),
    };
  };
}
