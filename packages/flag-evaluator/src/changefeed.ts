import { z } from "zod";
import type {
  SdkConfigResponse,
  SdkStreamChange,
  SdkStreamDelta,
} from "./sdk-wire.js";
import { configHashOf, type Snapshot } from "./snapshot.js";

/**
 * Áp thay đổi của change feed lên một snapshot — MỘT định nghĩa cho replica của
 * Service 2 (poller tầng 2) và cho provider trong ứng dụng khách (§6.3, §6.8)
 * [v4.7]. I15c ("áp N delta cho ra đúng snapshot tại cùng version") đúng bằng
 * CẤU TRÚC khi hai bên gọi cùng một hàm — như I26 với lõi đánh giá.
 */

/** Áp một phần tử lên snapshot — hàm thuần, idempotent theo từng loại */
export function applyChange(
  snapshot: Snapshot,
  change: SdkStreamChange,
): Snapshot {
  switch (change.kind) {
    case "flag":
      return {
        ...snapshot,
        flags: [
          ...snapshot.flags.filter((f) => f.key !== change.flag.key),
          change.flag,
        ],
      };
    case "flagAbsent":
      return {
        ...snapshot,
        flags: snapshot.flags.filter((f) => f.key !== change.key),
      };
    case "trackedFlags":
      return { ...snapshot, trackedFlags: [...change.trackedFlags] };
  }
}

/**
 * Nội dung có khớp con số server đã ghi không. `expected` RỖNG nghĩa là CHƯA CÓ
 * MỐC (environment chưa từng được ghi, hoặc vừa qua migration đổi định dạng),
 * không phải "hash bằng chuỗi rỗng" — so với nó là lệch 100% mà không có bug nào.
 */
export type HashVerdict =
  /** Nội dung khớp con số Service 2 đã ghi */
  | "ok"
  /** Lệch — đây là BUG, không phải chuyện thường ngày */
  | "mismatch"
  /** Chưa có gì để so */
  | "no-baseline";

export function hashVerdict(snapshot: Snapshot, expected: string): HashVerdict {
  if (expected === "") return "no-baseline";
  return configHashOf(snapshot) === expected ? "ok" : "mismatch";
}

export type DeltaOutcome =
  | { kind: "applied"; snapshot: Snapshot; configVersion: number }
  /** `toVersion` ≤ con trỏ — đã có, bỏ qua (không phải lỗi) */
  | { kind: "ignored" }
  | {
      kind: "resync";
      reason: "gap" | "hash-mismatch" | "malformed";
    };

/**
 * Áp một event `flag_changed` lên cache đang ở `configVersion` (§6.3):
 *   - `toVersion` ≤ con trỏ ⇒ bỏ qua;
 *   - `fromVersion` ≠ con trỏ ⇒ RESYNC (`gap`) — chỉ so `fromVersion`: một event
 *     có thể gộp NHIỀU dòng outbox, nên `toVersion` không nhất thiết `from + 1`;
 *   - áp xong, nội dung phải khớp `configHash` TẠI `toVersion` (I15a) — lệch ⇒
 *     RESYNC (`hash-mismatch`), vứt kết quả áp.
 * Không bao giờ ném: dữ liệu sai hình ⇒ RESYNC (`malformed`).
 */
export function applyDelta(
  cache: { snapshot: Snapshot; configVersion: number },
  delta: SdkStreamDelta,
): DeltaOutcome {
  try {
    if (delta.toVersion <= cache.configVersion) return { kind: "ignored" };
    if (delta.fromVersion !== cache.configVersion) {
      return { kind: "resync", reason: "gap" };
    }
    let snapshot = cache.snapshot;
    for (const change of delta.changes)
      snapshot = applyChange(snapshot, change);
    if (hashVerdict(snapshot, delta.configHash) === "mismatch") {
      return { kind: "resync", reason: "hash-mismatch" };
    }
    return { kind: "applied", snapshot, configVersion: delta.toVersion };
  } catch {
    return { kind: "resync", reason: "malformed" };
  }
}

// ------------------------------------------------------------- hình dạng dây

/**
 * Parse NÔNG phần vỏ của payload dây — đủ để áp và băm mà không ném. Bên trong
 * entry flag/segment để `unknown`: `prepareSnapshot` đã chịu trách nhiệm đánh dấu
 * phần hỏng (I33), và parse sâu ở đây là một bản thứ hai của cùng luật.
 */
const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const entrySchema = z.custom<Snapshot["flags"][number]>(
  (v) => isRecord(v) && typeof v["key"] === "string" && v["key"] !== "",
);

const segmentSchema = z.custom<Snapshot["segments"][number]>(
  (v) =>
    isRecord(v) &&
    typeof v["id"] === "string" &&
    Array.isArray(v["all"]) &&
    Array.isArray(v["userIds"]) &&
    v["userIds"].every((u) => typeof u === "string"),
);

const sdkConfigSchema = z.object({
  configVersion: z.number().int().nonnegative(),
  configHash: z.string(),
  environment: z.string(),
  trackedFlags: z.array(z.string()),
  flags: z.array(entrySchema),
  segments: z.array(segmentSchema),
});

const changeSchema: z.ZodType<SdkStreamChange> = z.discriminatedUnion("kind", [
  z.object({
    configVersion: z.number().int(),
    kind: z.literal("flag"),
    flag: entrySchema,
  }),
  z.object({
    configVersion: z.number().int(),
    kind: z.literal("flagAbsent"),
    key: z.string().min(1),
  }),
  z.object({
    configVersion: z.number().int(),
    kind: z.literal("trackedFlags"),
    trackedFlags: z.array(z.string()),
  }),
]);

const sdkDeltaSchema = z.object({
  fromVersion: z.number().int().nonnegative(),
  toVersion: z.number().int().nonnegative(),
  configHash: z.string(),
  changes: z.array(changeSchema),
});

/** Body `/sdk/config` hoặc `data` của event `snapshot`; sai hình ⇒ `undefined` */
export function parseSdkConfig(raw: unknown): SdkConfigResponse | undefined {
  const parsed = sdkConfigSchema.safeParse(raw);
  return parsed.success ? parsed.data : undefined;
}

/**
 * `data` của event `flag_changed`; sai hình ⇒ `undefined`. Phần tử có `kind` lạ
 * làm cả event sai hình — §6.8: gặp `kind` lạ thì RESYNC, không đoán.
 */
export function parseSdkDelta(raw: unknown): SdkStreamDelta | undefined {
  const parsed = sdkDeltaSchema.safeParse(raw);
  return parsed.success ? parsed.data : undefined;
}
