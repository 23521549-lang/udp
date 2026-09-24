import type { ProjectRole } from "@udp/db";
import type {
  PublicEnvironmentWire,
  PublicProjectWire,
  ResourceQuotaWire,
} from "@udp/shared-types/wire";
import type { PublicEnvironment, PublicProject } from "./project.types.js";

/**
 * [v4.11] Phép chiếu project từ hình DATABASE sang hình TRÊN DÂY.
 *
 * `PublicProject` là phép chiếu database (7 chỗ dùng) và cố ý giữ `Date`; `myRole` và
 * chuỗi ISO chỉ sống ở tầng wire. Gộp hai tầng — thêm `myRole` vào `PublicProject` — là
 * làm vỡ cả bảy chỗ dùng để sửa một chỗ.
 *
 * `myRole` là tham số BẮT BUỘC chứ không đọc từ đâu đó bên trong: mỗi route có một
 * nguồn khác nhau (middleware, hàng OWNER vừa tạo, truy vấn danh sách), và bắt bên gọi
 * nói rõ nguồn nào là cách duy nhất để không route nào quên.
 */
export const projectWire = (
  project: PublicProject,
  myRole: ProjectRole,
): PublicProjectWire => ({
  id: project.id,
  name: project.name,
  ownerId: project.ownerId,
  creationMode: project.creationMode,
  languageRuntime: project.languageRuntime,
  repoUrl: project.repoUrl,
  status: project.status,
  /**
   * Cột JSONB — kiểu Prisma là `JsonValue`. Ép kiểu ở đây là an toàn vì `sendJson`
   * parse ngay sau đó bằng `resourceQuotaWire.strict()`: một hàng lệch hình thành
   * 500 kèm log đúng trường, không thành dữ liệu sai trên màn hình.
   */
  resourceQuota: project.resourceQuota as ResourceQuotaWire,
  expiresAt: project.expiresAt?.toISOString() ?? null,
  createdAt: project.createdAt.toISOString(),
  myRole,
});

export const environmentWire = (
  env: PublicEnvironment,
): PublicEnvironmentWire => ({
  id: env.id,
  name: env.name,
  k8sNamespace: env.k8sNamespace,
  isProduction: env.isProduction,
  rank: env.rank,
  autoDeploy: env.autoDeploy,
});

/**
 * Vai đã được `requireMinProjectRole` lưu vào request.
 *
 * Route gọi hàm này đều đứng SAU middleware đó, nên `undefined` ở đây là lỗi lắp ráp
 * route chứ không phải dữ liệu người dùng — ném, không đoán một vai mặc định.
 */
export function roleOf(projectRole: ProjectRole | undefined): ProjectRole {
  if (projectRole === undefined) {
    throw new Error(
      "req.projectRole trống — route này phải đứng sau requireMinProjectRole",
    );
  }
  return projectRole;
}
