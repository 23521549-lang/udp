import { Router, type Request } from "express";
import {
  asyncHandler,
  NotFoundError,
  sendJson,
  ServiceUnavailableError,
  validateBody,
} from "@udp/http";
import {
  domainTargetStateSchema,
  domainUpgradeBodySchema,
  putDomainsBodySchema,
  type DomainTargetState,
  type DomainUpgradeBody,
  type PutDomainsBody,
} from "@udp/shared-types/domain-api";
import {
  domainDriftResponseWire,
  domainValidationResponseWire,
  jobResponseWire,
  projectDomainResponseWire,
  projectDomainsResponseWire,
  putDomainsResponseWire,
} from "@udp/shared-types/wire";
import { appDepsOf } from "../../core/app-deps.js";
import { requireAuth } from "../../core/http/middlewares/auth.middleware.js";
import {
  projectIdParam,
  requireMinProjectRole,
} from "../../core/http/middlewares/project-role.middleware.js";
import { requestUpgrade } from "./domain-apply.service.js";
import * as domains from "./project-domain.service.js";

/**
 * Domain của project (§9 "Domain", Plan #27 QĐ-1, QĐ-7, Plan #30). Đọc — VIEWER; kiểm thử
 * trạng thái đích — DEVELOPER (không ghi); lưu, quét ngay, nâng cấp — MAINTAINER (§8.6).
 */
export const projectDomainRouter: Router = Router({ mergeParams: true });

const DOMAIN_TYPE = /^[A-Z][A-Z_]{1,49}$/;

/** `:type` sai hình là "không có domain đó", không phải lỗi định dạng của một ô nhập */
function domainTypeOf(req: Request): string {
  const type = req.params.type ?? "";
  if (!DOMAIN_TYPE.test(type))
    throw new NotFoundError(`Không có domain ${type}`);
  return type;
}

projectDomainRouter.get(
  "/domains",
  requireAuth,
  requireMinProjectRole("VIEWER"),
  asyncHandler(async (req, res) => {
    sendJson(
      res,
      projectDomainsResponseWire,
      await domains.list(projectIdParam(req)),
    );
  }),
);

projectDomainRouter.post(
  "/domains/validate",
  requireAuth,
  requireMinProjectRole("DEVELOPER"),
  validateBody(domainTargetStateSchema),
  asyncHandler(async (req, res) => {
    sendJson(res, domainValidationResponseWire, {
      validation: await domains.validate(
        req.body as DomainTargetState,
        await appDepsOf(req).domainRegistry(),
      ),
    });
  }),
);

projectDomainRouter.put(
  "/domains",
  requireAuth,
  requireMinProjectRole("MAINTAINER"),
  validateBody(putDomainsBodySchema),
  asyncHandler(async (req, res) => {
    const deps = appDepsOf(req);
    const out = await domains.put(
      projectIdParam(req),
      req.body as PutDomainsBody,
      req,
      await deps.domainRegistry(),
      deps.provisioning.enqueue,
    );
    sendJson(res, putDomainsResponseWire, out.body, out.status);
  }),
);

projectDomainRouter.get(
  "/domains/:type",
  requireAuth,
  requireMinProjectRole("VIEWER"),
  asyncHandler(async (req, res) => {
    sendJson(res, projectDomainResponseWire, {
      domain: await domains.one(projectIdParam(req), domainTypeOf(req)),
    });
  }),
);

projectDomainRouter.get(
  "/domains/:type/drift",
  requireAuth,
  requireMinProjectRole("VIEWER"),
  asyncHandler(async (req, res) => {
    sendJson(res, domainDriftResponseWire, {
      drift: await domains.drift(projectIdParam(req), domainTypeOf(req)),
    });
  }),
);

/**
 * Quét drift NGAY một domain (§8.6 nhánh A, Plan #30 QĐ-4): đồng bộ, chỉ đọc, cùng
 * `scanDomainDrift` với lịch 6 giờ; trả phán quyết mới. Triển khai không chạy worker ⇒ 503.
 */
projectDomainRouter.post(
  "/domains/:type/drift",
  requireAuth,
  requireMinProjectRole("MAINTAINER"),
  asyncHandler(async (req, res) => {
    const projectId = projectIdParam(req);
    const type = domainTypeOf(req);
    const scan = appDepsOf(req).provisioning.scanDrift;
    if (scan === null) {
      throw new ServiceUnavailableError(
        "Triển khai này không chạy worker nên không quét drift được",
      );
    }
    await scan(projectId, type);
    sendJson(res, domainDriftResponseWire, {
      drift: await domains.drift(projectId, type),
    });
  }),
);

/** Nâng domain lên bản adapter máy chủ đang nạp (§8.6 nhánh B) — job `DOMAIN_APPLY` */
projectDomainRouter.post(
  "/domains/:type/upgrade",
  requireAuth,
  requireMinProjectRole("MAINTAINER"),
  validateBody(domainUpgradeBodySchema),
  asyncHandler(async (req, res) => {
    const deps = appDepsOf(req);
    const job = await requestUpgrade({
      projectId: projectIdParam(req),
      domainType: domainTypeOf(req),
      body: req.body as DomainUpgradeBody,
      request: req,
      registry: await deps.domainRegistry(),
      enqueue: deps.provisioning.enqueue,
    });
    sendJson(res, jobResponseWire, { job }, 202);
  }),
);
