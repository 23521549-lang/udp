import { Router, type Request } from "express";
import { prisma } from "../../core/db.js";
import { env } from "@udp/config";
import {
  asyncHandler,
  sendJson,
  uuidParam,
  validateBody,
  validateQuery,
} from "@udp/http";
import {
  adminCredentialsResponseWire,
  adminJobsResponseWire,
  adminOrphansResponseWire,
  adminProjectsResponseWire,
  adminSystemResponseWire,
  adminUserResponseWire,
  adminUsersResponseWire,
} from "@udp/shared-types/wire";
import {
  requireAuth,
  requirePlatformAdmin,
} from "../../core/http/middlewares/auth.middleware.js";
import * as adminService from "./admin.service.js";
import {
  listJobsQuerySchema,
  listProjectsQuerySchema,
  listUsersQuerySchema,
  updatePlatformRoleSchema,
  type AdminJobsQuery,
  type AdminProjectsQuery,
  type ListUsersQuery,
  type UpdatePlatformRoleInput,
} from "./admin.types.js";

/**
 * `/admin/*` (§9, §10.11) — chỉ PLATFORM_ADMIN. `requirePlatformAdmin` đọc vai từ
 * DATABASE mỗi request (không tin payload token 15 phút), nên người vừa bị hạ mất quyền
 * ngay lần gọi kế tiếp.
 *
 * Admin KHÔNG đi vòng quyền project: không route nào ở đây trả dữ liệu flag, rule hay
 * segment của tenant — chỉ siêu dữ liệu vận hành (§2.2 "platform_role chỉ dùng cho admin
 * endpoints toàn hệ").
 */
export const adminRouter: Router = Router();
adminRouter.use(requireAuth, requirePlatformAdmin);

const userIdOf = (req: Request): string =>
  uuidParam(req, "userId", "Mã người dùng không hợp lệ");

adminRouter.get(
  "/users",
  validateQuery(listUsersQuerySchema),
  asyncHandler(async (req, res) => {
    sendJson(res, adminUsersResponseWire, {
      users: await adminService.users(req.query as unknown as ListUsersQuery),
    });
  }),
);

adminRouter.patch(
  "/users/:userId/platform-role",
  validateBody(updatePlatformRoleSchema),
  asyncHandler(async (req, res) => {
    sendJson(res, adminUserResponseWire, {
      user: await adminService.setPlatformRole(
        userIdOf(req),
        req.body as UpdatePlatformRoleInput,
        req,
      ),
    });
  }),
);

adminRouter.get(
  "/projects",
  validateQuery(listProjectsQuerySchema),
  asyncHandler(async (req, res) => {
    sendJson(res, adminProjectsResponseWire, {
      projects: await adminService.projects(
        req.query as unknown as AdminProjectsQuery,
      ),
    });
  }),
);

adminRouter.get(
  "/credentials",
  asyncHandler(async (_req, res) => {
    sendJson(res, adminCredentialsResponseWire, {
      credentials: await adminService.credentials(),
    });
  }),
);

adminRouter.get(
  "/jobs",
  validateQuery(listJobsQuerySchema),
  asyncHandler(async (req, res) => {
    sendJson(res, adminJobsResponseWire, {
      jobs: await adminService.jobs(req.query as unknown as AdminJobsQuery),
    });
  }),
);

adminRouter.get(
  "/orphan-resources",
  asyncHandler(async (_req, res) => {
    sendJson(res, adminOrphansResponseWire, await adminService.orphans());
  }),
);

/**
 * Sức khoẻ ba service. Service 2 và 3 được hỏi qua `/readyz` của chúng với hạn 2 giây;
 * không trả lời trong hạn là `down` — trang admin phải nói "không biết" thành "hỏng",
 * không được treo.
 */
async function probe(
  url: string | undefined,
): Promise<"up" | "down" | "unknown"> {
  if (url === undefined || url === "") return "unknown";
  try {
    const res = await fetch(new URL("/readyz", url), {
      signal: AbortSignal.timeout(2000),
    });
    return res.ok ? "up" : "down";
  } catch {
    return "down";
  }
}

adminRouter.get(
  "/system/health",
  asyncHandler(async (_req, res) => {
    let database: "up" | "down" = "up";
    try {
      await prisma.$queryRaw`SELECT 1`;
    } catch {
      database = "down";
    }
    const [flagService, pdController] = await Promise.all([
      probe(env.FLAG_SERVICE_URL),
      probe(env.PD_CONTROLLER_URL),
    ]);
    sendJson(res, adminSystemResponseWire, {
      services: [
        { name: "udp-core-backend", status: "up" },
        { name: "udp-feature-flag-service", status: flagService },
        { name: "udp-pd-controller", status: pdController },
      ],
      database,
      checkedAt: new Date().toISOString(),
    });
  }),
);
