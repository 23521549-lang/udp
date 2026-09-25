import { z } from "zod";

export const listDeploymentsQuerySchema = z
  .object({
    envId: z.string().uuid(),
    limit: z.coerce.number().int().min(1).max(100).default(30),
  })
  .strict();
export type ListDeploymentsQuery = z.infer<typeof listDeploymentsQuerySchema>;

/**
 * `envId` tuỳ chọn: thiếu thì lấy env production (§2.2 "DORA chỉ tính deploy vào
 * production"). `days` giới hạn 365 — cửa sổ dài hơn là một truy vấn quét cả bảng.
 */
export const doraQuerySchema = z
  .object({
    envId: z.string().uuid().optional(),
    days: z.coerce.number().int().min(1).max(365).default(30),
  })
  .strict();
export type DoraQuery = z.infer<typeof doraQuerySchema>;
