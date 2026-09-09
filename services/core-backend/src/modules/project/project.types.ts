import { z } from "zod";
import { DEFAULT_RESOURCE_QUOTA } from "@udp/config";
import type { CreationMode, ProjectStatus } from "@udp/db";

/**
 * Trần tài nguyên. §4.4 gọi đây là "cưỡng chế, không phải gợi ý": trong mô hình
 * BYOC, một vòng lặp provisioning hỏng tiêu tiền thật của người dùng. Zod ở đây
 * là lớp kiểm thứ nhất; `AdapterRegistry.invoke()` là lớp thứ hai.
 */
export const resourceQuotaSchema = z.object({
  maxNodes: z.number().int().min(1).max(100),
  maxNodeSize: z.enum(["small", "medium", "large"]),
  maxDatabases: z.number().int().min(0).max(50),
  maxStorageGb: z.number().int().min(1).max(10_000),
  maxLoadBalancers: z.number().int().min(0).max(20),
});

/**
 * Body của `POST /projects`.
 *
 * §8.1 mô tả `{name, mode, runtime, quota}` còn §10.5 (wizard của Portal) chỉ
 * gửi `{name, mode, runtime}` — hai mục của tài liệu không khớp nhau, trong khi
 * `resource_quota` là `NOT NULL`. Chốt ở đây: quota là TUỲ CHỌN, thiếu thì lấy
 * `DEFAULT_RESOURCE_QUOTA`. Cách này thoả cả hai mục và giữ được nguyên tắc
 * "giá trị an toàn, người dùng phải chủ động nâng" của §4.4.
 */
export const createProjectSchema = z
  .object({
    name: z.string().trim().min(1, "Tên project không được để trống").max(255),
    creationMode: z.enum(["CREATE_NEW", "IMPORT_EXISTING"]),
    languageRuntime: z.string().trim().min(1, "Chưa chọn runtime").max(50),
    repoUrl: z.string().url("URL kho mã không hợp lệ").max(500).optional(),
    resourceQuota: resourceQuotaSchema.default({ ...DEFAULT_RESOURCE_QUOTA }),
  })
  /**
   * §2.2 ghi `repo_url` là "có nếu IMPORT_EXISTING". Không kiểm ở đây thì một
   * project IMPORT_EXISTING không có repo sẽ chỉ hỏng lúc provisioning — xa
   * chỗ người dùng gõ sai, và lúc đó đã tạo hàng trong database rồi.
   */
  .refine((data) => data.creationMode !== "IMPORT_EXISTING" || data.repoUrl !== undefined, {
    message: "Chế độ IMPORT_EXISTING phải kèm repoUrl",
    path: ["repoUrl"],
  });

export const updateQuotaSchema = z.object({ resourceQuota: resourceQuotaSchema });

/**
 * `expiresAt` nhận ISO-8601 **có offset**, hoặc `null` để bỏ hạn.
 *
 * `offset: true` không phải chi tiết thừa: `new Date("2026-09-09")` là 00:00
 * UTC, tức 07:00 giờ Việt Nam, còn `new Date("2026-09-09T00:00:00")` lại theo
 * giờ của máy chủ. Cùng một chuỗi cho hai thời điểm khác nhau tuỳ `TZ` của
 * container — bắt buộc offset là cách duy nhất để người gửi và người nhận nói
 * cùng một mốc.
 */
export const updateTtlSchema = z.object({
  expiresAt: z
    .string()
    .datetime({ offset: true, message: "expiresAt phải là ISO-8601 kèm offset múi giờ" })
    .nullable()
    .refine((value) => value === null || new Date(value).getTime() > Date.now(), {
      message: "expiresAt phải ở tương lai",
    }),
});

export type CreateProjectInput = z.infer<typeof createProjectSchema>;
export type UpdateQuotaInput = z.infer<typeof updateQuotaSchema>;
export type UpdateTtlInput = z.infer<typeof updateTtlSchema>;
export type ResourceQuota = z.infer<typeof resourceQuotaSchema>;

/**
 * Hình dạng project trả ra ngoài — khai tường minh vì cùng lý do với
 * `PublicUser`: cột nhạy cảm thêm sau này (ví dụ `cluster_access` chứa endpoint
 * nội bộ) sẽ KHÔNG tự lọt ra API.
 */
export interface PublicProject {
  id: string;
  name: string;
  ownerId: string;
  creationMode: CreationMode;
  languageRuntime: string;
  repoUrl: string | null;
  status: ProjectStatus;
  resourceQuota: unknown;
  expiresAt: Date | null;
  createdAt: Date;
}

export interface PublicEnvironment {
  id: string;
  name: string;
  k8sNamespace: string;
  isProduction: boolean;
  rank: number;
  autoDeploy: boolean;
}
