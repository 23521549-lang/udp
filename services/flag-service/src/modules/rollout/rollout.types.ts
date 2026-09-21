/**
 * Kết quả của `track`/`untrack` (§9 [v4.3]). Hai endpoint không nhận body; kết
 * quả nói rõ lần gọi này có đổi gì không để bên gọi (S1 lúc tạo rollout, lưới gỡ
 * nhãn của S3) ghi log và đếm metric đúng — gọi lặp là bình thường, không phải lỗi.
 */
export type TrackResult =
  | {
      flagKey: string;
      environmentId: string;
      /** Trạng thái SAU lần gọi */
      tracked: boolean;
      changed: boolean;
      /** Vì sao không đổi — vắng khi `changed` */
      skipped?: "already-tracked" | "not-tracked" | "active-session";
    }
  /**
   * Gỡ nhãn theo config mà config không còn: không còn gì để gỡ — mục đích của
   * lời gọi đã đạt, nên 200 chứ không 404. Nhờ vậy Service 3 coi MỌI 404 là lỗi
   * thật (gọi nhầm địa chỉ, Service 2 bản cũ chưa có route), không nuốt im lặng.
   */
  | { tracked: false; changed: false; skipped: "not-found" };
