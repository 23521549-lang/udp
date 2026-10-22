import type { RequestHandler } from "express";
import type { ProjectRole } from "@udp/db";
import {
  hasMinProjectRole,
  projectAccessOf,
} from "../../access/project-access.js";
import {
  ForbiddenError,
  NotFoundError,
  UnauthenticatedError,
  UUID_PATTERN,
  ValidationError,
} from "@udp/http";

/**
 * Quyền TRONG MỘT PROJECT — cặp đôi của `requirePlatformAdmin`.
 *
 * Bất biến I10: *mọi* route có tham số project đều phải đi qua đây, đối chiếu
 * với một danh sách miễn trừ tường minh. §12 T4 nói rõ lý do: không có nó, người
 * dùng chỉ cần đổi id trên URL là đọc được project của người khác.
 */

/**
 * Tên tham số route mang id của project.
 *
 * §9 dùng `/projects/:id` xuyên suốt, trong khi I10 và §12 T4 mô tả bằng chữ
 * "`:projectId`". Hai cách gọi cùng một thứ. Hằng số này là nơi duy nhất chốt
 * tên thật, để middleware, lint I10 và router không thể trôi khỏi nhau.
 */
export const PROJECT_ID_PARAM = "id";

/**
 * Chặn trước cửa: id phải là UUID.
 *
 * Không có bước này, `/api/v1/projects/abc` đi thẳng vào Prisma, Postgres ném
 * `22P02 invalid input syntax for type uuid`, mã đó không nằm trong bảng ánh xạ
 * của `@udp/db` nên rơi xuống nhánh cuối và thành **500 "Lỗi hệ thống"** — một
 * URL gõ sai bị báo cáo như sự cố máy chủ.
 */
function projectIdOf(req: {
  params: Record<string, string | undefined>;
}): string {
  const raw = req.params[PROJECT_ID_PARAM];

  if (raw === undefined || !UUID_PATTERN.test(raw)) {
    throw new ValidationError("Mã project không hợp lệ");
  }

  return raw;
}

/**
 * Yêu cầu người gọi có vai trò TỪ `minimum` TRỞ LÊN trong project. [v4.11, Plan #55] Vai là vai HIỆU LỰC —
 * cao nhất giữa thành viên trực tiếp và các nhóm được cấp quyền (`core/access/project-access.ts`).
 *
 * Ba điều đáng nói về những gì middleware này cố tình KHÔNG làm:
 *
 * 1. **PLATFORM_ADMIN không được đi vòng.** §2.2 nói `platform_role` "chỉ dùng
 *    cho admin endpoints toàn hệ", và §12 T4 đòi kiểm `ProjectMember` ở *mọi*
 *    endpoint có id project. Cho admin bỏ qua sẽ biến I10 thành vô nghĩa và mở
 *    một đường đọc dữ liệu tenant không để lại dấu trong `ProjectMember`. Quản
 *    trị viên có đường riêng của mình (`/admin/projects`).
 *
 * 2. **Không dùng mã `INSUFFICIENT_PERMISSIONS`.** Mã đó trong `ERROR_CATALOG`
 *    là 422 với tiêu đề "Cloud credential lacks required permissions" (§4.2) —
 *    nó nói về quyền IAM của credential cloud, không phải quyền của người dùng.
 *    Gắn nó ở đây làm client tra catalog thấy 422 trong khi HTTP thật là 403.
 *    `ForbiddenError` trần là đúng đường mà `requirePlatformAdmin` đang đi.
 *
 * 3. **Project đã soft-delete thì 404, không phải 403.** Xoá project chỉ đặt
 *    `status = 'DELETED'`; hàng `ProjectMember` vẫn nguyên. Nếu chỉ tra vai trò,
 *    mọi endpoint vẫn trả 200 trên một project người dùng tưởng đã xoá. Nạp
 *    `status` trong CÙNG truy vấn nên việc đóng cửa này không tốn thêm vòng nào.
 */
export const requireMinProjectRole =
  (minimum: ProjectRole): RequestHandler =>
  (req, _res, next) => {
    void (async () => {
      if (!req.user) {
        next(new UnauthenticatedError("Chưa đăng nhập"));
        return;
      }

      const projectId = projectIdOf(req);

      /**
       * Project theo khoá chính, cùng các nguồn vai lọc theo người gọi: hàng `project_members` đi qua
       * `(project_id, user_id)`, grant của nhóm qua `(project_id, team_id)` rồi `(team_id, user_id)` — không
       * phép quét nào, dù middleware này chạy trước MỌI request có project.
       */
      const access = await projectAccessOf(projectId, req.user.sub);

      // Không có vai và project không tồn tại phải KHÔNG phân biệt được từ
      // bên ngoài. Trả 403 cho một bên và 404 cho bên kia là biến endpoint
      // thành máy dò: kẻ tấn công đoán id và đọc được project nào có thật.
      // Cả hai đều 404.
      if (
        access === null ||
        access.role === null ||
        access.status === "DELETED"
      ) {
        next(new NotFoundError("Không tìm thấy project"));
        return;
      }

      if (!hasMinProjectRole(access.role, minimum)) {
        next(new ForbiddenError("Không đủ quyền trong project này"));
        return;
      }

      req.projectRole = access.role;
      next();
    })().catch(next);
  };

/**
 * Id project đã được `requireMinProjectRole` xác thực.
 *
 * Handler gọi hàm này thay vì đọc `req.params.id` trực tiếp: kiểu trả về là
 * `string` chứ không phải `string | undefined`, nên không chỗ nào phải viết `!`.
 */
export const projectIdParam = projectIdOf;
