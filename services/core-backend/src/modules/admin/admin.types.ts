import { z } from "zod";

export const listUsersQuerySchema = z
  .object({
    search: z.string().trim().min(1).max(100).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
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
  })
  .strict();
export type AdminJobsQuery = z.infer<typeof listJobsQuerySchema>;
