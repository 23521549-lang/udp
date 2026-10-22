import type { Timeline } from "./timeline.js";

/**
 * Bơm lỗi cho E5/E6 (§13.4) [v4.8] — trạng thái là một ĐỐI TƯỢNG truyền vào app,
 * không biến toàn cục; đồng hồ và nguồn ngẫu nhiên tiêm được để test tất định.
 *
 * Lỗi áp ở `POST /api/checkout`:
 *   - `scope: "flag-on"` (mặc định) — chỉ nhánh `on` của flag canary ("code mới"
 *     hỏng): đúng ca auto-rollback mức flag phải cứu.
 *   - `scope: "shared"` — mọi nhánh (code dùng chung hỏng): ĐỐI CHỨNG ÂM của E5 —
 *     rollback mức flag không được giúp gì (§14 E5 điểm 5).
 * Độ trễ có `rampSeconds`: tăng TUYẾN TÍNH từ 0 tới `ms` ("tăng dần" của §13.4).
 */

export type FaultScope = "flag-on" | "shared";
export type Branch = "on" | "off";

interface ErrorFault {
  p: number;
  scope: FaultScope;
}
interface LatencyFault {
  ms: number;
  rampSeconds: number;
  scope: FaultScope;
  startedAt: number;
}

export interface FaultDecision {
  delayMs: number;
  fail: boolean;
}

export interface BlastRadius {
  /** Request được PHỤC VỤ nhánh `on` từ lúc bơm lỗi — định nghĩa của §14 E5 */
  servedOn: number;
  /** Trong đó số request lỗi (5xx) */
  failedOn: number;
  /** Request (mọi nhánh) lỗi từ lúc bơm — đối chứng âm đo cái này trước/sau rollback */
  failedAll: number;
  servedAll: number;
  /** Lần cuối một request nhánh `on` được phục vụ */
  lastOnServedAt: number | undefined;
}

const emptyBlast = (): BlastRadius => ({
  servedOn: 0,
  failedOn: 0,
  failedAll: 0,
  servedAll: 0,
  lastOnServedAt: undefined,
});

export class ChaosState {
  private error: ErrorFault | undefined;
  private latency: LatencyFault | undefined;
  private blast = emptyBlast();
  private since: number | undefined;

  constructor(
    private readonly timeline: Timeline,
    private readonly random: () => number = Math.random,
  ) {}

  get active(): boolean {
    return this.error !== undefined || this.latency !== undefined;
  }

  setErrorRate(p: number, scope: FaultScope): void {
    this.error = { p, scope };
    this.turnedOn(`error-rate p=${String(p)} scope=${scope}`);
  }

  setLatency(ms: number, rampSeconds: number, scope: FaultScope): void {
    this.latency = { ms, rampSeconds, scope, startedAt: this.timeline.now() };
    this.turnedOn(
      `latency ms=${String(ms)} ramp=${String(rampSeconds)}s scope=${scope}`,
    );
  }

  reset(): void {
    if (this.active)
      this.timeline.record({ type: "fault-off", at: this.timeline.now() });
    this.error = undefined;
    this.latency = undefined;
  }

  /** Quyết định cho MỘT request checkout ở nhánh `branch` */
  decide(branch: Branch): FaultDecision {
    const hits = (scope: FaultScope): boolean =>
      scope === "shared" || branch === "on";
    let delayMs = 0;
    if (this.latency !== undefined && hits(this.latency.scope)) {
      const { ms, rampSeconds, startedAt } = this.latency;
      const progress =
        rampSeconds === 0
          ? 1
          : Math.min(
              1,
              (this.timeline.now() - startedAt) / (rampSeconds * 1000),
            );
      delayMs = ms * progress;
    }
    const fail =
      this.error !== undefined &&
      hits(this.error.scope) &&
      this.random() < this.error.p;
    return { delayMs, fail };
  }

  /** Ghi một request đã phục vụ — blast radius tính từ lần bơm lỗi đầu của phiên */
  recordServed(branch: Branch, failed: boolean): void {
    if (this.since === undefined) return;
    this.blast.servedAll += 1;
    if (failed) this.blast.failedAll += 1;
    if (branch === "on") {
      this.blast.servedOn += 1;
      if (failed) this.blast.failedOn += 1;
      this.blast.lastOnServedAt = this.timeline.now();
    }
  }

  /** Bắt đầu phiên đo mới: xoá blast radius và dòng thời gian */
  clearSession(): void {
    this.reset();
    this.blast = emptyBlast();
    this.since = undefined;
    this.timeline.clear();
  }

  describe(): {
    error: ErrorFault | undefined;
    latency: LatencyFault | undefined;
    blastRadius: BlastRadius;
    since: number | undefined;
  } {
    return {
      error: this.error,
      latency: this.latency,
      blastRadius: { ...this.blast },
      since: this.since,
    };
  }

  private turnedOn(fault: string): void {
    const at = this.timeline.now();
    this.since ??= at;
    this.timeline.record({ type: "fault-on", at, fault });
  }
}
