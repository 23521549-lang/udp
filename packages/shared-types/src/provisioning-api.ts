import { z } from "zod";

/**
 * [v4.11] Hợp đồng provisioning của project (Plan #28, §8.1 giai đoạn 2, §9) — một nguồn cho
 * Portal và Service 1.
 */

/**
 * Body của `POST /projects/:id/provision`. `confirmedMonthlyUsd` là con số chi phí người
 * dùng đã THẤY ở bước xem trước (§4.4 lớp 2): project có environment production phải gửi
 * đúng con số của ước tính hiện tại, lệch hay thiếu là 428.
 */
export const provisionBodySchema = z
  .object({
    confirmedMonthlyUsd: z.number().nonnegative().optional(),
  })
  .strict();
export type ProvisionBody = z.infer<typeof provisionBodySchema>;

/**
 * Vì sao chưa provisioning được — xem trước trả CẢ danh sách để Portal khoá nút và nói lý
 * do; `POST /provision` từ chối với lý do đầu tiên. Cũng là khoá i18n của Portal. (Chưa có
 * credential thì không có gì để xem trước: 409 `cloud-not-configured` như bước cloud.)
 */
export const PROVISION_BLOCKERS = [
  "project-not-draft",
  "job-active",
  "cloud-not-validated",
  "egress-not-configured",
  "domains-invalid",
  /** Lượt trước còn tài nguyên `ORPHAN_SUSPECTED`: người vận hành dọn trước khi chạy lại */
  "orphans-pending",
] as const;
export type ProvisionBlocker = (typeof PROVISION_BLOCKERS)[number];

/** Slug `type` của lỗi Portal rẽ nhánh — không thêm mã vào catalog mã lỗi (I36) */
export const PROVISION_ERROR_SLUGS = {
  blocked: "provision-blocked",
  /** Job đã qua điểm hủy được (đang bù trừ hay đã kết thúc) */
  notCancellable: "job-not-cancellable",
  /** Đổi credential khi job đang chạy: job đang dùng credential cũ trên cloud */
  credentialLocked: "cloud-credential-locked",
} as const;
