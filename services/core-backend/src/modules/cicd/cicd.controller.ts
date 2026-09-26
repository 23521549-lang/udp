import express, { Router, type Request } from "express";
import { CICD_WEBHOOK } from "@udp/config";
import {
  asyncHandler,
  jsonTooLargeHandler,
  normalizedPathOf,
  sendJson,
} from "@udp/http";
import {
  cicdSecretResponseWire,
  cicdStatusResponseWire,
  deployAcceptedResponseWire,
  pipelineTemplateResponseWire,
} from "@udp/shared-types/wire";
import { appDepsOf } from "../../core/app-deps.js";
import { API_PREFIX } from "../../core/http/api-prefix.js";
import { requireAuth } from "../../core/http/middlewares/auth.middleware.js";
import {
  projectIdParam,
  requireMinProjectRole,
} from "../../core/http/middlewares/project-role.middleware.js";
import * as cicd from "./cicd.service.js";
import { receiveWebhook } from "./cicd-webhook.service.js";

/**
 * CI/CD (§8.3, §9 "Webhooks", Plan #36).
 *
 * Hai router. `projectCicdRouter` gắn dưới `/projects/:id` như mọi route của project: trạng thái
 * — VIEWER; template pipeline — DEVELOPER (người dán nó vào repo); sinh/xoay secret — MAINTAINER,
 * cùng bậc với lưu cấu hình domain (§8.6).
 *
 * `cicdWebhookRouter` là đường CI gọi vào: không phiên, không CSRF (gắn TRƯỚC lớp CSRF ở `app.ts`),
 * xác thực bằng chữ ký trên thân THÔ — nên thân phải tới đây nguyên byte: `isCicdWebhookRequest`
 * chừa nó khỏi parser JSON toàn cục, và parser thô riêng có trần `CICD_WEBHOOK.bodyLimitBytes`.
 */

export const projectCicdRouter: Router = Router({ mergeParams: true });

projectCicdRouter.get(
  "/domains/CICD/webhook",
  requireAuth,
  requireMinProjectRole("VIEWER"),
  asyncHandler(async (req, res) => {
    sendJson(res, cicdStatusResponseWire, {
      cicd: await cicd.status(projectIdParam(req)),
    });
  }),
);

projectCicdRouter.post(
  "/domains/CICD/webhook-secret",
  requireAuth,
  requireMinProjectRole("MAINTAINER"),
  asyncHandler(async (req, res) => {
    sendJson(
      res,
      cicdSecretResponseWire,
      await cicd.rotateSecret(projectIdParam(req), req),
    );
  }),
);

projectCicdRouter.get(
  "/domains/CICD/pipeline-template",
  requireAuth,
  requireMinProjectRole("DEVELOPER"),
  asyncHandler(async (req, res) => {
    sendJson(
      res,
      pipelineTemplateResponseWire,
      await cicd.pipelineTemplate(
        projectIdParam(req),
        await appDepsOf(req).domainRegistry(),
      ),
    );
  }),
);

const WEBHOOK_BASE = "/webhooks/cicd";
const WEBHOOK_PATH = new RegExp(`^${API_PREFIX}${WEBHOOK_BASE}/[^/]+/[^/]+$`);

/** Vị từ cho `jsonBodyExcept` — cùng chuỗi đường dẫn với route bên dưới */
export const isCicdWebhookRequest = (req: Request): boolean =>
  req.method === "POST" && WEBHOOK_PATH.test(normalizedPathOf(req));

export const cicdWebhookRouter: Router = Router();

cicdWebhookRouter.post(
  `${WEBHOOK_BASE}/:projectId/:provider`,
  express.raw({ type: () => true, limit: CICD_WEBHOOK.bodyLimitBytes }),
  asyncHandler(async (req, res) => {
    const outcome = await receiveWebhook({
      projectId: req.params.projectId ?? "",
      provider: req.params.provider ?? "",
      // Thân rỗng: `express.raw` để nguyên `{}` — chữ ký trên chuỗi rỗng vẫn phải được kiểm
      rawBody: Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0),
      request: req,
      registry: await appDepsOf(req).domainRegistry(),
      enqueueDeploy: appDepsOf(req).provisioning.enqueueDeploy,
    });
    const accepted =
      outcome.status === "started" || outcome.status === "pending";
    sendJson(res, deployAcceptedResponseWire, outcome, accepted ? 202 : 200);
  }),
  jsonTooLargeHandler(
    `Thân webhook vượt ${String(CICD_WEBHOOK.bodyLimitBytes)} byte`,
  ),
);
