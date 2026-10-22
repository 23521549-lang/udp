import { domainTargetStateSchema } from "@udp/shared-types/domain-api";
import { z } from "zod";
import { provisionPayloadSchema } from "../provisioning/provision-plan.js";

/**
 * Payload của job `DOMAIN_APPLY` (Plan #30 QĐ-1).
 *
 * - `infra`: ảnh chụp hạ tầng của lượt PROVISION gần nhất (cloud, region, tag) — worker cần
 *   nó để lấy credential và chạm cluster, như mọi job khác trên `ProvisioningJob`.
 * - `change`: việc phải làm. `apply` mang TRẠNG THÁI ĐÍCH đầy đủ (không phải phần thay đổi):
 *   bảng `domain_configs` là thứ ĐANG chạy trên cluster, đích chỉ vào bảng khi đã áp xong.
 *   `upgrade` nâng một domain lên bản adapter mà registry đang nạp (§8.6).
 *   `reapply` [v4.11, Plan #45] áp lại MỘT domain về chính cấu hình đang lưu — không mang cấu
 *   hình: hàng `domain_configs` là mục tiêu của nó (§9 `POST …/retry`).
 */
export const domainApplyPayloadSchema = z
  .object({
    infra: provisionPayloadSchema,
    change: z.discriminatedUnion("kind", [
      z
        .object({ kind: z.literal("apply"), target: domainTargetStateSchema })
        .strict(),
      z
        .object({
          kind: z.literal("upgrade"),
          domainType: z.string().min(1),
        })
        .strict(),
      z
        .object({
          kind: z.literal("reapply"),
          domainType: z.string().min(1),
        })
        .strict(),
    ]),
  })
  .strict();

export type DomainApplyPayload = z.infer<typeof domainApplyPayloadSchema>;
