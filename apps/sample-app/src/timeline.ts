/**
 * Dòng thời gian của một phiên đo (E5, §13.4) — mọi mốc theo ĐỒNG HỒ CỦA APP
 * (`Date.now()`); harness đặt mọi thành phần trên cùng một máy nên đó cũng là
 * đồng hồ của Service 3 và Prometheus (đăng ký trước E5, "một miền đồng hồ").
 */

export type TimelineEvent =
  | { type: "fault-on"; at: number; fault: string }
  | { type: "fault-off"; at: number }
  /** Nhóm user dò đang ở nhánh `on` lúc bơm lỗi — mẫu để đo T3 */
  | { type: "cohort"; at: number; size: number; probes: number }
  | {
      type: "config-changed";
      at: number;
      /** Tỉ lệ `on` của CẢ nhóm dò sau thay đổi — phân loại promote/rollback */
      onShare: number;
      direction: "increase" | "decrease" | "unchanged";
      /** Số user của nhóm con (lúc bơm lỗi) còn ở `on` */
      cohortRemaining: number;
    }
  /**
   * User cuối của nhóm con rời `on` — T3 của E5. `blast`: số đếm blast radius CHỐT
   * tại đúng T3 (§14 E5: request phục vụ nhánh lỗi trong [T0, T3])
   */
  | { type: "cohort-cleared"; at: number; blast: unknown };

/** Trần số mốc — một phiên chạy dài không được giữ bộ nhớ vô hạn */
const MAX_EVENTS = 10_000;

export class Timeline {
  private readonly events: TimelineEvent[] = [];

  constructor(readonly now: () => number = Date.now) {}

  record(event: TimelineEvent): void {
    if (this.events.length >= MAX_EVENTS) this.events.shift();
    this.events.push(event);
  }

  list(): readonly TimelineEvent[] {
    return this.events;
  }

  clear(): void {
    this.events.length = 0;
  }
}
