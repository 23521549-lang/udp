import {
  ProviderEvents,
  type Client,
  type EventDetails,
} from "@openfeature/server-sdk";
import type { Timeline } from "./timeline.js";

/**
 * Đo T3 của E5 — "người dùng không còn bị ảnh hưởng" — theo đăng ký trước [v4.8].
 *
 * "Lần đầu phục vụ `off` sau khi bơm lỗi" KHÔNG dùng được: ở canary < 100% phần
 * lớn người dùng vốn đã ở `off`, MTTR đo ra ≈ 0. Thay vào đó: một NHÓM DÒ user id
 * cố định; lúc bơm lỗi ghi nhóm con đang ở nhánh `on` (đánh giá tại chỗ, µs); mỗi
 * `PROVIDER_CONFIGURATION_CHANGED` chạm flag ⇒ đánh giá lại, ghi tỉ lệ `on` của cả
 * nhóm (phân loại promote/rollback) và số user nhóm con còn ở `on`; hết ⇒
 * `cohort-cleared` = T3. Provider áp mỗi thay đổi nguyên khối, nên cả nhóm con
 * rời `on` trong cùng một sự kiện.
 */

export class RolloutObserver {
  private readonly probes: string[];
  private cohort: Set<string> = new Set();
  private onShare: number | undefined;
  private detach: (() => void) | undefined;
  /**
   * Sự kiện xử lý TUẦN TỰ: mỗi lần đánh giá lại nhóm dò là bất đồng bộ, hai sự
   * kiện sát nhau chạy song song sẽ ghi timeline sai thứ tự và so `onShare` với
   * giá trị của sự kiện chưa xong
   */
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private readonly client: Client,
    private readonly flagKey: string,
    private readonly timeline: Timeline,
    probeUsers: number,
    /** Số đếm blast radius lúc T3 — chốt vào mốc `cohort-cleared` */
    private readonly blastAt: () => unknown = () => undefined,
  ) {
    this.probes = Array.from(
      { length: probeUsers },
      (_, i) => `probe-${String(i)}`,
    );
  }

  start(): void {
    const handler = (details?: EventDetails): void => {
      const changed: unknown = details?.flagsChanged;
      if (!Array.isArray(changed) || !changed.includes(this.flagKey)) return;
      this.queue = this.queue
        .then(() => this.onConfigChanged())
        .catch((err: unknown) => {
          console.warn("đánh giá lại nhóm dò lỗi", err);
        });
    };
    this.client.addHandler(ProviderEvents.ConfigurationChanged, handler);
    this.detach = () => {
      this.client.removeHandler(ProviderEvents.ConfigurationChanged, handler);
    };
  }

  stop(): void {
    this.detach?.();
  }

  /** Chờ mọi sự kiện đang xử lý xong (test, tắt êm) */
  settled(): Promise<void> {
    return this.queue;
  }

  /** Gọi lúc bơm lỗi: chốt nhóm con đang ở `on` */
  async captureCohort(): Promise<number> {
    const on = await this.onProbes();
    this.cohort = new Set(on);
    this.onShare = on.length / this.probes.length;
    this.timeline.record({
      type: "cohort",
      at: this.timeline.now(),
      size: this.cohort.size,
      probes: this.probes.length,
    });
    return this.cohort.size;
  }

  private async onConfigChanged(): Promise<void> {
    const at = this.timeline.now();
    const on = new Set(await this.onProbes());
    const share = on.size / this.probes.length;
    const previous = this.onShare;
    this.onShare = share;
    const remaining = [...this.cohort].filter((u) => on.has(u)).length;
    const hadCohort = this.cohort.size > 0;
    this.timeline.record({
      type: "config-changed",
      at,
      onShare: share,
      direction:
        previous === undefined || share === previous
          ? "unchanged"
          : share > previous
            ? "increase"
            : "decrease",
      cohortRemaining: remaining,
    });
    if (hadCohort && remaining === 0) {
      this.timeline.record({
        type: "cohort-cleared",
        at,
        blast: this.blastAt(),
      });
      this.cohort = new Set();
    }
  }

  private async onProbes(): Promise<string[]> {
    const results = await Promise.all(
      this.probes.map(async (targetingKey) => ({
        targetingKey,
        on: await this.client.getBooleanValue(this.flagKey, false, {
          targetingKey,
        }),
      })),
    );
    return results.filter((r) => r.on).map((r) => r.targetingKey);
  }
}
