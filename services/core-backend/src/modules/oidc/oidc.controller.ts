import { Router } from "express";
import { sendJson } from "@udp/http";
import {
  discoveryWire,
  jwksWire,
  oidcPaths,
  type OidcIssuer,
} from "./oidc.issuer.js";

/**
 * Hai endpoint CÔNG KHAI mà cloud của khách đọc để kiểm token UDP ký (OpenID Discovery).
 * Ngoài `/api/v1`, không CSRF (chỉ GET), không rate limit của API: Google STS và Entra ID
 * đọc lại chúng theo lịch riêng và không được bị chặn.
 *
 * Dựng theo issuer của app (không phải router cấp module): đường dẫn suy từ issuer, và
 * chưa cấu hình issuer thì không có route nào — 404 của `notFoundHandler`.
 */

/** Khoá đổi hiếm; 5 phút cache vừa giảm tải vừa để một lần xoay khoá lan nhanh */
const CACHE = "public, max-age=300";

export function createOidcRouter(issuer: OidcIssuer | null): Router {
  const router = Router();
  if (issuer === null) return router;
  const paths = oidcPaths(issuer.issuer);

  router.get(paths.discovery, (_req, res) => {
    res.setHeader("Cache-Control", CACHE);
    sendJson(res, discoveryWire, issuer.discovery());
  });

  router.get(paths.jwks, (_req, res) => {
    res.setHeader("Cache-Control", CACHE);
    sendJson(res, jwksWire, issuer.jwks());
  });

  return router;
}
