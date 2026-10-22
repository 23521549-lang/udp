/**
 * Fence — lưới đầu tiên trước MỌI side effect (§7.1, ADR-05, I17).
 *
 * Một worker có thể mất lease giữa chừng (GC pause quá 60 giây, mạng đứt lúc
 * renew) mà không biết. Vòng renew (`lease.ts`) phát hiện điều đó và `abort()`
 * fence; từ đó mọi `assert()` ném, nên bước kế tiếp — PATCH sang S2, ghi DB —
 * không bao giờ chạy trên một quyền đã mất. Đây là lớp thứ nhất; lớp thứ hai là
 * `If-Match` ở S2 (I23), lớp thứ ba là `updateIfVersion` (optimistic lock).
 */
export class FenceAbortedError extends Error {
  constructor(
    readonly sessionId: string,
    readonly reason: string,
  ) {
    super(`Fence đã đóng cho session ${sessionId}: ${reason}`);
    this.name = "FenceAbortedError";
  }
}

export class Fence {
  private reason: string | undefined;

  constructor(
    readonly sessionId: string,
    /** Version đã claim — fencing token cho `If-Match` và `updateIfVersion` */
    readonly version: number,
    readonly workerId: string,
  ) {}

  get aborted(): boolean {
    return this.reason !== undefined;
  }

  /** Vì sao đóng — reconciler phân biệt "mất lease" với "shutdown" khi quyết định nhả lease */
  get abortReason(): string | undefined {
    return this.reason;
  }

  abort(reason: string): void {
    this.reason ??= reason;
  }

  /** Ném nếu đã mất lease — gọi ngay trước từng side effect, không gọi một lần đầu vòng */
  assert(): void {
    if (this.reason !== undefined) {
      throw new FenceAbortedError(this.sessionId, this.reason);
    }
  }

  /** `If-Match: "<sessionId>:<version>"` theo đúng chữ §7.3/§9 — có ngoặc kép */
  ifMatch(): string {
    return `"${this.sessionId}:${String(this.version)}"`;
  }
}
