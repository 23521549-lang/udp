import { z } from "zod";
import {
  EVIDENCE_DORA_DAYS,
  type EvidenceDoraDays,
} from "@udp/shared-types/wire";

export const listUsersQuerySchema = z
  .object({
    search: z.string().trim().min(1).max(100).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
    offset: z.coerce.number().int().min(0).default(0),
  })
  .strict();
export type ListUsersQuery = z.infer<typeof listUsersQuerySchema>;

export const updatePlatformRoleSchema = z
  .object({ platformRole: z.enum(["USER", "PLATFORM_ADMIN"]) })
  .strict();
export type UpdatePlatformRoleInput = z.infer<typeof updatePlatformRoleSchema>;

export const listProjectsQuerySchema = z
  .object({
    status: z
      .enum(["DRAFT", "PROVISIONING", "ACTIVE", "ERROR", "DELETED"])
      .optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
    offset: z.coerce.number().int().min(0).default(0),
  })
  .strict();
export type AdminProjectsQuery = z.infer<typeof listProjectsQuerySchema>;

export const listJobsQuerySchema = z
  .object({
    state: z
      .enum([
        "QUEUED",
        "NETWORK",
        "CLUSTER",
        "CLUSTER_ACCESS",
        "DOMAINS",
        "DONE",
        "CANCEL_REQUESTED",
        "COMPENSATING",
        "COMPENSATION_FAILED",
        "FAILED",
      ])
      .default("FAILED"),
    limit: z.coerce.number().int().min(1).max(100).default(50),
    offset: z.coerce.number().int().min(0).default(0),
  })
  .strict();
export type AdminJobsQuery = z.infer<typeof listJobsQuerySchema>;

const isEvidenceWindow = (days: number): days is EvidenceDoraDays =>
  EVIDENCE_DORA_DAYS.some((w) => w === days);

/** [v4.11, Plan #56] Cửa sổ của E10 trên trang Bằng chứng — ba lựa chọn cố định, mặc định 30 ngày */
export const evidenceDoraQuerySchema = z
  .object({
    days: z.coerce
      .number()
      .refine(isEvidenceWindow, "days phải là 7, 30 hoặc 90")
      .default(30),
  })
  .strict();
export type EvidenceDoraQuery = z.infer<typeof evidenceDoraQuerySchema>;
