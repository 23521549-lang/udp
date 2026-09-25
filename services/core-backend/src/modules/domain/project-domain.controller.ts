import { Router, type Request } from "express";
import { asyncHandler, NotFoundError, sendJson, validateBody } from "@udp/http";
import {
  domainTargetStateSchema,
  putDomainsBodySchema,
  type DomainTargetState,
  type PutDomainsBody,
} from "@udp/shared-types/domain-api";
import {
  domainDriftResponseWire,
  domainValidationResponseWire,
  projectDomainResponseWire,
  projectDomainsResponseWire,
} from "@udp/shared-types/wire";
import { appDepsOf } from "../../core/app-deps.js";
import { requireAuth } from "../../core/http/middlewares/auth.middleware.js";
import {
  projectIdParam,
  requireMinProjectRole,
} from "../../core/http/middlewares/project-role.middleware.js";
import * as domains from "./project-domain.service.js";

/**
 * Domain của project (§9 "Domain", Plan #27 QĐ-1, QĐ-7). Đọc — VIEWER; kiểm thử trạng thái
 * đích — DEVELOPER (không ghi); lưu — MAINTAINER (§8.6 dùng MAINTAINER cho thao tác domain).
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
    sendJson(
      res,
      projectDomainsResponseWire,
      await domains.put(
        projectIdParam(req),
        req.body as PutDomainsBody,
        req,
        await appDepsOf(req).domainRegistry(),
      ),
    );
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
