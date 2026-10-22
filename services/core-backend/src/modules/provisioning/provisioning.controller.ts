import { Router, type Request } from "express";
import {
  asyncHandler,
  logger,
  NotFoundError,
  sendJson,
  uuidParam,
  validateBody,
} from "@udp/http";
import {
  provisionBodySchema,
  type ProvisionBody,
} from "@udp/shared-types/provisioning-api";
import {
  jobDetailResponseWire,
  jobListResponseWire,
  jobResponseWire,
  provisionPreviewResponseWire,
} from "@udp/shared-types/wire";
import { appDepsOf } from "../../core/app-deps.js";
import { requireAuth } from "../../core/http/middlewares/auth.middleware.js";
import { idempotent } from "../../core/http/middlewares/idempotency.middleware.js";
import {
  projectIdParam,
  requireMinProjectRole,
} from "../../core/http/middlewares/project-role.middleware.js";
import { retryEnvironmentJob } from "../environment/environment-job.js";
import { streamJob } from "./job-stream.js";
import * as provisioningService from "./provisioning.service.js";
import type { ProvisioningDeps } from "./provisioning.service.js";

/**
 * Provisioning của project (§9 "Project — Provisioning Phase", Plan #28 P5).
 *
 * Xem trước — MAINTAINER, như đọc cấu hình cloud. Chạy và hủy — OWNER: tiêu (và thôi tiêu)
 * tiền trong tài khoản cloud của khách (QĐ-8). Đọc tiến độ — VIEWER.
 */
export const provisioningRouter: Router = Router({ mergeParams: true });

const jobIdParam = (req: Request): string =>
  uuidParam(req, "jobId", "Mã job không hợp lệ");

async function depsOf(req: Request): Promise<ProvisioningDeps> {
  const deps = appDepsOf(req);
  return {
    platform: deps.cloud,
    registry: await deps.domainRegistry(),
    egressCidrs: deps.provisioning.egressCidrs,
  };
}

provisioningRouter.get(
  "/preview",
  requireAuth,
  requireMinProjectRole("MAINTAINER"),
  asyncHandler(async (req, res) => {
    sendJson(res, provisionPreviewResponseWire, {
      preview: await provisioningService.preview(
        projectIdParam(req),
        await depsOf(req),
      ),
    });
  }),
);

provisioningRouter.post(
  "/provision",
  requireAuth,
  requireMinProjectRole("OWNER"),
  validateBody(provisionBodySchema),
  // §9 bảng Idempotency-Key: bấm hai lần do mạng chậm trả CÙNG một job
  idempotent("POST /projects/:id/provision"),
  asyncHandler(async (req, res) => {
    const job = await provisioningService.provision(
      projectIdParam(req),
      req.body as ProvisionBody,
      req,
      await depsOf(req),
      appDepsOf(req).provisioning.enqueue,
    );
    sendJson(res, jobResponseWire, { job }, 202);
  }),
);

provisioningRouter.get(
  "/jobs",
  requireAuth,
  requireMinProjectRole("VIEWER"),
  asyncHandler(async (req, res) => {
    sendJson(res, jobListResponseWire, {
      jobs: await provisioningService.list(projectIdParam(req)),
    });
  }),
);

provisioningRouter.get(
  "/jobs/:jobId",
  requireAuth,
  requireMinProjectRole("VIEWER"),
  asyncHandler(async (req, res) => {
    sendJson(
      res,
      jobDetailResponseWire,
      await provisioningService.detail(projectIdParam(req), jobIdParam(req)),
    );
  }),
);

/**
 * SSE (§8.1, QĐ-6): ảnh chụp đọc từ database, đã qua CÙNG schema dây với `GET /jobs/:jobId`
 * — Portal nhận sự kiện thì `invalidateQueries`, không dựng state từ luồng này (§10.14).
 */
provisioningRouter.get(
  "/jobs/:jobId/stream",
  requireAuth,
  requireMinProjectRole("VIEWER"),
  asyncHandler(async (req, res) => {
    const projectId = projectIdParam(req);
    const jobId = jobIdParam(req);
    // 404 bằng đường lỗi thường, TRƯỚC khi mở luồng
    await provisioningService.detail(projectId, jobId);

    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-store",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    let closed = false;
    req.on("close", () => {
      closed = true;
    });
    try {
      await streamJob({
        snapshot: async () => {
          const detail = await provisioningService
            .detail(projectId, jobId)
            .catch((e: unknown) => {
              if (e instanceof NotFoundError) return null;
              throw e;
            });
          if (detail === null) return null;
          return {
            json: JSON.stringify(jobDetailResponseWire.parse(detail)),
            terminal: provisioningService.isTerminal(detail.job.state),
          };
        },
        send: (event, data) => {
          res.write(`event: ${event}
data: ${data}

`);
        },
        closed: () => closed,
        sleep: (ms) =>
          new Promise((resolve) => {
            setTimeout(resolve, ms);
          }),
        now: Date.now,
      });
    } catch (err) {
      // Header đã gửi: không còn đường trả lỗi dạng problem — đóng luồng, Portal tự mở lại
      logger.warn({ err, jobId }, "Luồng tiến độ job dừng vì lỗi đọc");
    } finally {
      res.end();
    }
  }),
);

provisioningRouter.post(
  "/jobs/:jobId/cancel",
  requireAuth,
  requireMinProjectRole("OWNER"),
  asyncHandler(async (req, res) => {
    const job = await provisioningService.cancel(
      projectIdParam(req),
      jobIdParam(req),
      req,
    );
    sendJson(res, jobResponseWire, { job }, 202);
  }),
);

/**
 * [v4.11, Plan #40 QĐ-8] Thử lại một `ENVIRONMENT_APPLY` đã FAILED — job mới cùng payload. Loại
 * job khác ⇒ 409 `job-not-retryable`: chúng có đường thử lại của riêng mình (D-P19).
 */
provisioningRouter.post(
  "/jobs/:jobId/retry",
  requireAuth,
  requireMinProjectRole("OWNER"),
  asyncHandler(async (req, res) => {
    const job = await retryEnvironmentJob(
      appDepsOf(req).provisioning.enqueue,
      projectIdParam(req),
      jobIdParam(req),
      req,
    );
    sendJson(res, jobResponseWire, { job }, 202);
  }),
);
