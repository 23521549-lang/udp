import type { PrismaClient, SdkKeyType } from "@udp/db";
import type { Snapshot } from "@udp/flag-evaluator";
import { snapshotOf } from "../modules/flag/flag.repository.js";

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

    clear() {
      entries.clear();
      inflight.clear();
    },
  };
}

/**
 * Ngân sách của một lần đọc nhất quán.
 *
 * Ngắn hơn ngân sách ghi (20s) vì đây là đường phục vụ request: một SDK chờ 20
 * giây cho `/sdk/config` thì đã tự bỏ cuộc từ lâu, và transaction vẫn giữ chỗ
 * trong pool suốt thời gian đó.
 */
const READ_BUDGET = {
  maxWait: 5_000,
  timeout: 10_000,
  /**
   * `RepeatableRead`, KHÔNG phải mặc định.
   *
   * Đây là nửa còn lại của phép sửa, và là nửa dễ bỏ sót nhất: gói hai câu lệnh
   * vào một transaction ở mức `ReadCommitted` **không đủ**, vì `ReadCommitted`
   * lấy một ảnh chụp MỚI cho từng câu lệnh. Một lần ghi chen giữa "đọc version"
   * và "đọc snapshot" vẫn cho ra bộ ba lệch pha, y như khi không có transaction.
   * `RepeatableRead` cố định một ảnh chụp cho cả transaction — đó mới là thứ làm
   * `(version, hash, snapshot)` nói về cùng một khoảnh khắc.
   *
   * An toàn ở đây vì transaction này CHỈ ĐỌC: `40001` của `RepeatableRead` chỉ
   * xảy ra khi ghi vào hàng đã bị transaction khác sửa.
   */
  isolationLevel: "RepeatableRead",
} as const;

/**
 * Đọc `(version, hash, snapshot)` của một environment trong MỘT ảnh chụp.
 *
 * Tách khỏi `createSnapshotCache` để cache kiểm được mà không cần database, và
 * để chỗ duy nhất biết về mức cô lập nằm ở đây chứ không rải khắp nơi.
 */
export function prismaEntryLoader(client: PrismaClient): EntryLoader {
  return (environmentId) =>
    client.$transaction(async (tx) => {
      const row = await tx.environment.findUniqueOrThrow({
        where: { id: environmentId },
        select: { name: true, configVersion: true, configHash: true },
      });

      return {
        environmentId,
        environmentName: row.name,
        configVersion: row.configVersion,
        configHash: row.configHash,
        snapshot: await snapshotOf(tx, environmentId),
      };
    }, READ_BUDGET);
}
