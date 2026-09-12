import type { Prisma } from "@udp/db";
import type { Snapshot, SnapshotEntry } from "@udp/flag-evaluator";
import { verifyHash } from "./checksum.verifier.js";
import type {
  ChangeFeed,
  ChangeRecord,
  EnvironmentState,
} from "./change-feed.interface.js";
import type { ConfigEntry } from "./snapshot.cache.js";

/**
 * TẦNG 2 — áp delta liên tục theo con trỏ `config_version` (ADR-05).
 *
 * Nguyên tắc chi phối cả file: **tầng này không được phép làm hỏng trạng thái.**
 * Mọi thứ nó không chắc — hổng trong chuỗi, `change_type` chưa hiểu, payload sai
 * hình dạng, hash lệch sau khi áp — đều dẫn về đúng MỘT hành động: bảo người gọi
 * lấy snapshot. Không có nhánh nào ở đây kết thúc bằng "cứ dùng tạm".
 */

/**
 * Trần số delta áp trong một vòng.
 *
 * KHÔNG có trong thiết kế — đây là lựa chọn kỹ thuật, và lý do phải nói ra: một
 * replica tụt lại rất xa mà vẫn cố áp từng dòng sẽ đọc về hàng nghìn payload,
 * mỗi payload là một entry flag đầy đủ. Lúc đó snapshot vừa rẻ hơn vừa cho kết
 * quả giống hệt. Con số 100 chọn theo hình dạng dữ liệu chứ không theo phép đo:
 * quá ngưỡng này thì một `snapshotOf` (một câu lệnh) gần như chắc chắn rẻ hơn.
 */
const MAX_DELTA_BATCH = 100;

export type FallbackReason =
  /** Dòng kế tiếp không phải `con trỏ + 1` — dòng ở giữa đã bị dọn hoặc chưa commit */
  | "gap"
  /** Còn xa quá, snapshot rẻ hơn */
  | "too-far-behind"
  /** `change_type` mà tầng này chưa biết áp */
  | "unknown-change-type"
  /** Payload không mang nổi một entry flag */
  | "malformed-payload"
  /** Áp hết những gì đọc được mà con trỏ vẫn chưa tới version thật */
  | "incomplete"
  /** Áp xong nhưng nội dung KHÔNG khớp checksum — đây là bug */
  | "hash-mismatch";

export type PollOutcome =
  | {
      kind: "applied";
      entry: ConfigEntry;
      /** Đúng những dòng đã áp, theo thứ tự — hub SSE chiếu chúng thành `changes[]` */
      records: readonly ChangeRecord[];
    }
  | { kind: "fallback"; reason: FallbackReason };

/**
 * Rút entry flag ra khỏi payload — kiểm NÔNG, có chủ đích.
 *
 * Chỉ kiểm đủ để biết "có phải hình dạng ta ghi ra không". Không kiểm sâu, vì
 * kiểm sâu ở đây là viết bản cài đặt thứ hai của cùng một lược đồ, và hai bản
 * song song thì trôi khỏi nhau. Thứ thật sự canh nội dung là `verifyHash` chạy
 * ngay sau khi áp: sai một byte ở bất kỳ đâu cũng làm hash lệch, và lệch thì rơi
 * tầng. Đó chính là mô hình "tầng 1 là bộ kiểm chứng của tầng 2" của ADR-05.
 */
export function flagOf(payload: Prisma.JsonValue): SnapshotEntry | null {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload))
    return null;

  const flag: unknown = (payload as { flag?: unknown }).flag;
  if (flag === null || typeof flag !== "object" || Array.isArray(flag))
    return null;

  const key: unknown = (flag as { key?: unknown }).key;
  if (typeof key !== "string" || key.length === 0) return null;

  return flag as unknown as SnapshotEntry;
}

/**
 * Áp MỘT dòng lên danh sách flag.
 *
 * `change_type` chưa biết trả `"unknown-change-type"` — KHÔNG ném, và đây không
 * phải chuyện phong cách. Từ vựng §2.2 lớn dần (v4.1 thêm `rule.ramped`), và một
 * replica chạy phiên bản cũ gặp giá trị mới phải rơi về snapshot chứ không chết.
 * §16 bắt triển khai "replica trước, writer sau"; nhánh này là lưới an toàn khi
 * thứ tự đó bị làm ngược. Service 3 cũng là writer của sổ này (kill-switch §7.6,
 * ghi thẳng database lúc Service 2 đang chết) — một `switch` vét cạn có
 * `default: throw` sẽ ném đúng lúc đó. Rơi về snapshot thì thay đổi vẫn tới nơi,
 * chỉ chậm hơn một vòng.
 */
function applyRecord(
  flags: readonly SnapshotEntry[],
  record: ChangeRecord,
): SnapshotEntry[] | FallbackReason {
  switch (record.changeType) {
    case "flag.created":
    case "flag.updated":
    case "flag.archived":
    /**
     * Ba loại của đường ghi rule mang CÙNG hình dạng `{ flag: entry }` (§2.2):
     * `SnapshotFlag` đã chứa cả `isEnabled` lẫn `rules[]`, nên thay entry theo
     * `key` là đúng cho bật/tắt, cho thay danh sách rule, và cho ramp trọng số.
     * Trường thêm như `rolloutSessionId` của `rule.ramped` được `flagOf` bỏ qua.
     */
    case "rule.replaced":
    case "rule.ramped":
    case "envconfig.toggled": {
      const flag = flagOf(record.payload);
      if (flag === null) return "malformed-payload";
      return [...flags.filter((f) => f.key !== flag.key), flag];
    }
    default:
      return "unknown-change-type";
  }
}

/**
 * Đọc và áp mọi delta từ con trỏ tới trạng thái đích.
 *
 * `target` do TẦNG 1 cung cấp trong cùng vòng poll, và phải mang CẢ HAI con số.
 * `configVersion` để biết đi tới đâu mới là đuổi kịp — thiếu nó thì "đọc được
 * bao nhiêu áp bấy nhiêu" trông giống thành công trong khi vẫn đang tụt lại.
 * `configHash` để đối chiếu nội dung, và nó phải là hash TẠI VERSION ĐÍCH: hash
 * đang nằm trong cache là hash của trạng thái TRƯỚC lô delta này, nên so với nó
 * là bảo đảm lệch ở mọi lần áp thành công.
 */
export async function pollDeltas(
  feed: ChangeFeed,
  cached: ConfigEntry,
  target: EnvironmentState,
): Promise<PollOutcome> {
  if (target.configVersion - cached.configVersion > MAX_DELTA_BATCH) {
    return { kind: "fallback", reason: "too-far-behind" };
  }

  const records = await feed.deltasSince(
    cached.environmentId,
    cached.configVersion,
    MAX_DELTA_BATCH,
  );

  let cursor = cached.configVersion;
  let flags: readonly SnapshotEntry[] = cached.snapshot.flags;
  const appliedRecords: ChangeRecord[] = [];

  for (const record of records) {
    /**
     * LIÊN TỤC, không chỉ tăng dần.
     *
     * `config_version` được cấp dưới row-lock giữ tới commit, nên thứ tự version
     * trùng thứ tự commit và không có hổng TẠM THỜI (I15b). Một hổng thật sự vì
     * thế luôn là hổng VĨNH VIỄN — dòng đã bị dọn sau 7 ngày, hoặc một writer
     * khác đã tăng version mà không ghi outbox. Cả hai đều chỉ snapshot mới sửa
     * được, nên chờ thêm một vòng là chờ vô ích.
     */
    if (record.configVersion !== cursor + 1) {
      return { kind: "fallback", reason: "gap" };
    }

    const applied = applyRecord(flags, record);
    if (typeof applied === "string") {
      return { kind: "fallback", reason: applied };
    }

    flags = applied;
    cursor = record.configVersion;
    appliedRecords.push(record);
  }

  if (cursor !== target.configVersion) {
    return { kind: "fallback", reason: "incomplete" };
  }

  const snapshot: Snapshot = { ...cached.snapshot, flags: [...flags] };

  /**
   * Đối chiếu NGAY, không đợi vòng 60 giây.
   *
   * §1.4 đặt phép tự kiểm ở chu kỳ 60 giây vì hình dung nó phải đọc snapshot về
   * mới tính được hash. Ở đây thì không: tầng 1 vừa mang `config_hash` thật về
   * trong cùng vòng poll, còn snapshot vừa áp đang nằm trong bộ nhớ. Phép so vì
   * thế thuần CPU và miễn phí — và một delta sai nội dung bị bắt ngay thay vì
   * được phục vụ cho tới một phút sau.
   */
  const verdict = verifyHash(snapshot, target.configHash);
  if (verdict === "mismatch") {
    return { kind: "fallback", reason: "hash-mismatch" };
  }

  /**
   * Bộ ba mới sinh ra CÙNG NHAU, đúng kỷ luật của `ConfigEntry`: version và hash
   * lấy từ một lần đọc của tầng 1, snapshot là kết quả áp đúng lô delta dẫn tới
   * chính version đó.
   */
  return {
    kind: "applied",
    entry: {
      ...cached,
      configVersion: target.configVersion,
      configHash: target.configHash,
      snapshot,
    },
    records: appliedRecords,
  };
}
