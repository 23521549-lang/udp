import type { CreatedResource, CreatedResourceKind } from "../cloud.js";

/**
 * [v4.10] Cổng của hiện thực giả tất định (§13.2).
 *
 * `CloudControl` là **cửa hậu tác động ngoài luồng**: xoá tag, xoá tài nguyên, bơm lỗi.
 * Nó là một cổng chứ không phải một tiện ích của cloud mô phỏng, vì đó là điều kiện để
 * bộ hợp đồng là HỢP ĐỒNG: khi trả nợ `I31-localstack`, `control` được hiện thực bằng
 * SDK cloud thật và **thân test không đổi một dòng**.
 */

/** Ba hạng lỗi mà adapter phải phân biệt — trộn chúng lại là một chế độ hỏng thật */
export type InjectedFaultClass =
  | "throttle"
  | "transient5xx"
  | "permanent4xx"
  /** Cloud đã ghi state nhưng client không nhận được phản hồi — đây là điểm crash K3 */
  | "commit-then-timeout";

/** Một lời gọi đã xảy ra, theo thứ tự — oracle của mọi phép kiểm về thứ tự */
export interface CloudCallRecord {
  at: number;
  verb: string;
  kind: CreatedResourceKind | "unknown";
  /** Danh tính worker, để K9 khẳng định "0 lời gọi ghi sau khi mất lease" */
  workerId: string;
  idempotencyKey?: string;
}

export interface CloudControl {
  /** Khách xoá tag `udp.key` ngoài luồng — điểm crash K8 */
  removeTag(resourceId: string, tagKey: string): Promise<void>;
  /** Khách xoá tài nguyên ngoài luồng — điểm crash K7 */
  deleteOutOfBand(resourceId: string): Promise<void>;
  /** Bơm lỗi cho lời gọi thứ `n` của một `kind` */
  failNthCall(
    kind: CreatedResourceKind,
    n: number,
    fault: InjectedFaultClass,
  ): Promise<void>;
  /**
   * Cửa sổ lan truyền tag: `lookup` theo tag trả `indeterminate` trong `ms` đầu sau
   * `create`. Đây là nguồn lỗi "tạo trùng" thật trên AWS, và là ô `K2b` của §4.5.
   */
  setTagPropagationDelay(ms: number): Promise<void>;
  /** Mọi thứ đang có trên "cloud", kể cả nhiễu */
  listAll(): Promise<CreatedResource[]>;
  /** Nhật ký lời gọi có thứ tự */
  calls(): Promise<CloudCallRecord[]>;
}

/**
 * Hằng số kỳ vọng **viết tay**.
 *
 * Không suy từ `steps.length` của chính adapter: suy từ hiện thực là một tautology —
 * một adapter khai THIẾU một step vẫn xanh vì kỳ vọng tự co lại theo nó.
 */
export interface CloudFixture {
  /** Tổng số tài nguyên một lần provision đầy đủ phải tạo */
  expectedResourceCount: number;
  /** Bảng `kind → số lượng`, để một step biến mất là một test đỏ chứ không phải một dòng diff */
  expectedByKind: Readonly<Partial<Record<CreatedResourceKind, number>>>;
  /** Số step của fixture — `CRASH_POINTS.length` KHÔNG chặn được việc nó tụt từ 13 xuống 1 */
  expectedStepCount: number;
}
