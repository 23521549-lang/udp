import { z } from "zod";
import { provisionPayloadSchema } from "../provisioning/provision-plan.js";

/**
 * Payload của job `ENVIRONMENT_APPLY` (Plan #40 QĐ-6, D-P31): hạ tầng của lượt PROVISION đã xong
 * (worker cần nó để chạm cluster, cùng khuôn `DOMAIN_APPLY`) và BẢN CHỤP environment. Bản chụp,
 * không chỉ id: với REMOVE, hàng environment đã bị xoá trong transaction tạo job — job vẫn phải
 * biết namespace nào cần dọn.
 */
export const environmentApplyPayloadSchema = z
  .object({
    infra: provisionPayloadSchema,
    change: z
      .object({
        action: z.enum(["ADD", "REMOVE"]),
        environment: z
          .object({
            id: z.string().uuid(),
            name: z.string().min(1),
            k8sNamespace: z.string().min(1),
            isProduction: z.boolean(),
          })
          .strict(),
      })
      .strict(),
  })
  .strict();

export type EnvironmentApplyPayload = z.infer<
  typeof environmentApplyPayloadSchema
>;
