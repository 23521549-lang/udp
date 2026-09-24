import { Router } from "express";
import { asyncHandler, sendJson } from "@udp/http";
import {
  auditListResponseWire,
  projectDetailResponseWire,
  projectListResponseWire,
  projectResponseWire,
} from "@udp/shared-types/wire";
import {
  requireAuth,
  requireUser,
} from "../../core/http/middlewares/auth.middleware.js";
import {
  projectIdParam,
  requireMinProjectRole,
} from "../../core/http/middlewares/project-role.middleware.js";
import { validateBody, validateQuery } from "@udp/http";
import * as auditRepository from "../audit/audit.repository.js";
import { auditQuerySchema, type AuditQuery } from "../audit/audit.types.js";
import { environmentRouter } from "../environment/environment.controller.js";
import { memberRouter } from "../member/member.controller.js";
import { flagRouter } from "../flag/flag.controller.js";
import { rolloutRouter } from "../rollout/rollout.controller.js";
import { segmentRouter } from "../segment/segment.routes.js";
import * as projectService from "./project.service.js";
import { auditEntryWireOf } from "../audit/audit.view.js";
import { environmentWire, projectWire, roleOf } from "./project.view.js";
import {
  createProjectSchema,
  updateQuotaSchema,
  updateTtlSchema,
} from "./project.types.js";

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
      requireUser(req).sub,
      req,
    );
    // §8.1: 201 kèm cả danh sách environment, vì wizard của Portal hiển thị
    // ngay ba môi trường vừa sinh mà không gọi thêm lượt nào.
    //
    // [v4.11] `myRole: "OWNER"` TƯỜNG MINH: route này không qua
    // `requireMinProjectRole`, và repository tạo hàng OWNER trong cùng lệnh. Thiếu
    // dòng này thì `sendJson` ném SAU KHI transaction đã commit ⇒ người dùng thấy
    // lỗi, bấm lại ⇒ project thứ hai.
    sendJson(
      res,
      projectDetailResponseWire,
      {
        project: projectWire(project, "OWNER"),
        environments: environments.map(environmentWire),
      },
      201,
    );
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
    const projects = await projectService.listForUser(requireUser(req).sub);
    sendJson(res, projectListResponseWire, {
      projects: projects.map(({ myRole, ...project }) =>
        projectWire(project, myRole),
      ),
    });
  }),
);

projectRouter.get(
  "/:id",
  requireAuth,
  requireMinProjectRole("VIEWER"),
  asyncHandler(async (req, res) => {
    const { environments, ...project } = await projectService.getById(
      projectIdParam(req),
    );
    sendJson(res, projectDetailResponseWire, {
      project: projectWire(project, roleOf(req.projectRole)),
      environments: environments.map(environmentWire),
    });
  }),
);

/** §9: "OWNER chỉnh trần tài nguyên" */
projectRouter.patch(
  "/:id/quota",
  requireAuth,
  requireMinProjectRole("OWNER"),
  validateBody(updateQuotaSchema),
  asyncHandler(async (req, res) => {
    const project = await projectService.updateQuota(
      projectIdParam(req),
      req.body,
      req,
    );
    sendJson(res, projectResponseWire, {
      project: projectWire(project, roleOf(req.projectRole)),
    });
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
    const project = await projectService.updateTtl(
      projectIdParam(req),
      req.body,
      req,
    );
    sendJson(res, projectResponseWire, {
      project: projectWire(project, roleOf(req.projectRole)),
    });
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
    sendJson(res, auditListResponseWire, {
      entries: entries.map(auditEntryWireOf),
    });
  }),
);

/**
 * Thành viên và chuyển quyền sở hữu gắn dưới `/:id`.
 *
 * Đặt SAU các route tĩnh ở trên là có chủ đích: Express khớp theo thứ tự đăng
 * ký, và `use("/:id", ...)` sẽ nuốt mọi đường dẫn con nếu đứng trước.
 */
projectRouter.use("/:id", memberRouter);
projectRouter.use("/:id", rolloutRouter);
projectRouter.use("/:id", segmentRouter);
projectRouter.use("/:id", environmentRouter);
projectRouter.use("/:id", flagRouter);
