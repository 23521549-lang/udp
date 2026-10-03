import {
  applyDelta,
  canonicalJson,
  etagOf,
  prepareSnapshot,
  type DeltaOutcome,
  type PreparedSnapshot,
  type SdkConfigResponse,
  type SdkStreamDelta,
  type Snapshot,
} from "@udp/flag-evaluator";

/**
 * Cache cấu hình của MỘT environment trong provider (§6.8) [v4.7] — thuần, không
 * I/O. Giữ snapshot, bản đã dựng cho đánh giá (một lần mỗi version), con trỏ, và
 * tập `trackedFlags` (sửa TẠI CHỖ: hook đọc cùng một `Set` suốt đời provider).
 *
 * Con trỏ là `configVersion` ĐÃ ÁP — không phải `id` cuối của stream: một event
 * nhận được mà không áp được không được làm con trỏ tiến.
 */

/** Vì sao cache phải RESYNC — cho log chẩn đoán của provider */
export type ResyncReason =
  | Extract<DeltaOutcome, { kind: "resync" }>["reason"]
  | "no-baseline-cache"
  | "bad-cursor"
  | "unknown-event"
  | "malformed-event";

export type StoreDeltaOutcome =
  | { kind: "applied"; changed: string[] }
  | { kind: "ignored" }
  | { kind: "resync"; reason: ResyncReason };

export class ConfigStore {
  private current: Snapshot | undefined;
  private preparedSnapshot: PreparedSnapshot | undefined;
  private version = -1;
  private lastEtag: string | undefined;
  private resync = false;
  readonly trackedFlags = new Set<string>();

  get hasData(): boolean {
    return this.current !== undefined;
  }

  get configVersion(): number {
    return this.version;
  }

  /** Snapshot đang phục vụ — I15c so nó với `/sdk/config` cùng version */
  get snapshot(): Snapshot | undefined {
    return this.current;
  }

  get prepared(): PreparedSnapshot | undefined {
    return this.preparedSnapshot;
  }

  /** ETag của cấu hình đang giữ — `If-None-Match` của polling (revalidate) */
  get etag(): string | undefined {
    return this.lastEtag;
  }

  /**
   * Cache có thể đang sai nội dung (hash lệch, hổng con trỏ, dữ liệu sai hình):
   * giữ tới khi áp được một SNAPSHOT. Trong lúc này polling không gửi
   * `If-None-Match` và stream mở không con trỏ — revalidate sẽ nhận 304 "xác nhận"
   * đúng cái cache đang hỏng.
   */
  get needsResync(): boolean {
    return this.resync;
  }

  markNeedsResync(): void {
    this.resync = true;
  }

  /** Thay toàn bộ cache (snapshot từ `/sdk/config` hoặc event `snapshot`) */
  replace(config: SdkConfigResponse, etag: string | undefined): string[] {
    const next: Snapshot = {
      flags: config.flags,
      segments: config.segments,
      trackedFlags: config.trackedFlags,
    };
    const changed = changedKeys(this.current, next);
    this.install(next, config.configVersion);
    this.lastEtag = etag ?? etagOf(config.configVersion);
    this.resync = false;
    return changed;
  }

  /** Áp một `flag_changed` bằng hàm áp delta DÙNG CHUNG với Service 2 (I15c) */
  applyDelta(delta: SdkStreamDelta): StoreDeltaOutcome {
    if (this.current === undefined)
      return { kind: "resync", reason: "no-baseline-cache" };
    if (this.resync) return { kind: "resync", reason: "gap" };
    const out = applyDelta(
      { snapshot: this.current, configVersion: this.version },
      delta,
    );
    if (out.kind === "ignored") return out;
    if (out.kind === "resync") {
      this.resync = true;
      return out;
    }
    /**
     * [v4.9] `changes` rỗng ⇒ nội dung y nguyên: chỉ tiến con trỏ và ETag (C-17).
     *
     * `applyDelta` đã so `configHash` với nội dung đang giữ trước khi trả
     * `applied`, nên snapshot ra là CHÍNH object cũ — không có gì để cài lại.
     * Bỏ qua `install` là bỏ `prepareSnapshot`, thứ tốn O(số flag × số rule) cho
     * một thay đổi không đổi gì (hub gửi event này khi thu hồi SDK key, L1). Đây
     * là tối ưu CPU thuần: `changedKeys` của hai snapshot bằng nhau vốn đã rỗng,
     * nên không sự kiện `CONFIGURATION_CHANGED` nào biến mất.
     */
    if (out.snapshot === this.current) {
      this.version = out.configVersion;
      this.lastEtag = etagOf(out.configVersion);
      return { kind: "applied", changed: [] };
    }
    const changed = changedKeys(this.current, out.snapshot);
    this.install(out.snapshot, out.configVersion);
    // Đúng giá trị ETag của `/sdk/config` tại version này — poll sau đó nhận 304
    this.lastEtag = etagOf(out.configVersion);
    return { kind: "applied", changed };
  }

  private install(snapshot: Snapshot, version: number): void {
    this.current = snapshot;
    this.preparedSnapshot = prepareSnapshot(snapshot);
    this.version = version;
    this.trackedFlags.clear();
    for (const key of snapshot.trackedFlags) this.trackedFlags.add(key);
  }
}

/** id segment mà một flag trỏ tới qua rule SEGMENT */
function segmentRefsOf(entry: Snapshot["flags"][number]): string[] {
  if (!("rules" in entry)) return [];
  const ids: string[] = [];
  for (const rule of entry.rules) {
    const id = (rule.condition as { segmentId?: unknown } | null)?.segmentId;
    if (rule.type === "SEGMENT" && typeof id === "string") ids.push(id);
  }
  return ids;
}

/**
 * Key flag có KẾT QUẢ ĐÁNH GIÁ có thể đã đổi — `flagsChanged` của
 * CONFIGURATION_CHANGED: entry của nó đổi, HOẶC một segment nó trỏ tới đổi (đổi
 * segment đổi kết quả của mọi flag dùng nó mà entry flag y nguyên). `flagAbsent`
 * của một flag vốn đã vắng, delta chỉ đổi `trackedFlags`, snapshot y hệt ⇒ rỗng
 * (không phát sự kiện). Lỗi chuẩn hoá (không thể với dữ liệu JSON) ⇒ coi mọi key
 * là đổi — thà báo thừa còn hơn nuốt một thay đổi.
 */
function changedKeys(before: Snapshot | undefined, after: Snapshot): string[] {
  const index = <T>(
    items: readonly T[],
    keyOf: (item: T) => string,
  ): Map<string, string> => {
    const map = new Map<string, string>();
    for (const item of items) map.set(keyOf(item), canonicalJson(item));
    return map;
  };
  const diff = (a: Map<string, string>, b: Map<string, string>): Set<string> =>
    new Set([...a.keys(), ...b.keys()].filter((k) => a.get(k) !== b.get(k)));
  try {
    const changed = diff(
      index(before?.flags ?? [], (f) => f.key),
      index(after.flags, (f) => f.key),
    );
    const segments = diff(
      index(before?.segments ?? [], (s) => s.id),
      index(after.segments, (s) => s.id),
    );
    if (segments.size > 0) {
      for (const entry of after.flags) {
        if (segmentRefsOf(entry).some((id) => segments.has(id)))
          changed.add(entry.key);
      }
    }
    return [...changed].sort();
  } catch {
    return after.flags.map((f) => f.key).sort();
  }
}
