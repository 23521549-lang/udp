import { Router } from "express";
import { asyncHandler, sendJson } from "@udp/http";
import { domainCatalogResponseWire } from "@udp/shared-types/wire";
import { appDepsOf } from "../../core/app-deps.js";
import { requireAuth } from "../../core/http/middlewares/auth.middleware.js";
import { buildCatalog } from "./domain-catalog.service.js";

/**
 * `GET /domains/catalog` — KHÔNG thuộc project (§9 v4: bỏ scope project). Mọi người đã
 * đăng nhập đọc được: đó là danh sách công cụ UDP hỗ trợ, không lộ gì của ai.
 */
export const domainCatalogRouter: Router = Router();

domainCatalogRouter.get(
  "/catalog",
  requireAuth,
  asyncHandler(async (req, res) => {
    sendJson(res, domainCatalogResponseWire, {
      domains: await buildCatalog(await appDepsOf(req).domainRegistry()),
    });
  }),
);
