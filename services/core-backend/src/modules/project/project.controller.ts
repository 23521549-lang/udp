import { Router } from "express";
import { asyncHandler } from "../../core/http/error-handler.js";
import { requireAuth } from "../../core/http/middlewares/auth.middleware.js";
import {
  projectIdParam,
  requireMinProjectRole,
} from "../../core/http/middlewares/project-role.middleware.js";
import { validateBody, validateQuery } from "../../core/http/validate.js";
import * as auditRepository from "../audit/audit.repository.js";
import { auditQuerySchema, type AuditQuery } from "../audit/audit.types.js";
import { memberRouter } from "../member/member.controller.js";
import * as projectService from "./project.service.js";
import { createProjectSchema, updateQuotaSchema, updateTtlSchema } from "./project.types.js";

export const projectRouter: Router = Router();

/**
 * `POST /projects` KHÔNG qua `requireMinProjectRole` — và không thể qua: chưa
 * có project nào để kiểm vai trò. Cùng lý do với `GET /projects`, vốn không có
 * id trên đường dẫn. Cả hai nằm trong danh sách miễn trừ tường minh mà bất biến
 * I10 yêu cầu; danh sách ấy được canh bằng lint, không phải bằng trí nhớ.
 */
projectRouter.post(
  "/",
  requireAuth,
  validateBody(createProjectSchema),
  asyncHandler(async (req, res) => {
    const { environments, ...project } = await projectService.create(
      req.body,
      req.user!.sub,
      req,
    );
    // §8.1: 201 kèm cả danh sách environment, vì wizard của Portal hiển thị
    // ngay ba môi trường vừa sinh mà không gọi thêm lượt nào.
    res.status(201).json({ project, environments });
  }),
);

/**
 * Lọc theo tư cách thành viên nằm trong repository, không phải ở đây.
 *
 * Route này không có id project nên I10 không phủ tới, tức là không middleware
 * nào chặn giúp. §12.2 tầng 1 vì thế phải sống trong chính câu truy vấn.
 */
projectRouter.get(
  "/",
  requireAuth,
  asyncHandler(async (req, res) => {
    res.json({ projects: await projectService.listForUser(req.user!.sub) });
  }),
);

projectRouter.get(
  "/:id",
  requireAuth,
  requireMinProjectRole("VIEWER"),
  asyncHandler(async (req, res) => {
    const { environments, ...project } = await projectService.getById(projectIdParam(req));
    res.json({ project, environments });
  }),
);

/** §9: "OWNER chỉnh trần tài nguyên" */
projectRouter.patch(
  "/:id/quota",
  requireAuth,
  requireMinProjectRole("OWNER"),
  validateBody(updateQuotaSchema),
  asyncHandler(async (req, res) => {
    res.json({ project: await projectService.updateQuota(projectIdParam(req), req.body, req) });
  }),
);

/**
 * Gia hạn TTL. Thiết kế không nói vai trò tối thiểu; chốt OWNER vì §4.4 gửi
 * cảnh báo hết hạn cho chủ sở hữu, và vì kéo dài TTL là kéo dài chi phí thật
 * trên tài khoản cloud của chính người đó.
 */
projectRouter.patch(
  "/:id/ttl",
  requireAuth,
  requireMinProjectRole("OWNER"),
  validateBody(updateTtlSchema),
  asyncHandler(async (req, res) => {
    res.json({ project: await projectService.updateTtl(projectIdParam(req), req.body, req) });
  }),
);

projectRouter.delete(
  "/:id",
  requireAuth,
  requireMinProjectRole("OWNER"),
  asyncHandler(async (req, res) => {
    await projectService.remove(projectIdParam(req), req);
    res.status(204).end();
  }),
);

/**
 * Nhật ký kiểm toán đặt ở đây chứ không ở `modules/audit/`: cây thư mục §3.1
 * chốt module audit chỉ có `audit.service.ts` và `audit.repository.ts`, không
 * có controller. Đường dẫn thì thuộc về project, nên route sống cùng project.
 *
 * VIEWER đọc được: thiết kế không quy định, và audit là công cụ để thành viên
 * hiểu chuyện gì đã xảy ra với project của mình. Nội dung nhạy cảm đã bị
 * `redact()` chặn trước khi ghi, nên mở cho VIEWER không thêm rủi ro mới.
 */
projectRouter.get(
  "/:id/audit",
  requireAuth,
  requireMinProjectRole("VIEWER"),
  validateQuery(auditQuerySchema),
  asyncHandler(async (req, res) => {
    const entries = await auditRepository.list(
      projectIdParam(req),
      req.query as unknown as AuditQuery,
    );
    res.json({ entries });
  }),
);

/**
 * Thành viên và chuyển quyền sở hữu gắn dưới `/:id`.
 *
 * Đặt SAU các route tĩnh ở trên là có chủ đích: Express khớp theo thứ tự đăng
 * ký, và `use("/:id", ...)` sẽ nuốt mọi đường dẫn con nếu đứng trước.
 */
projectRouter.use("/:id", memberRouter);
