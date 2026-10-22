import type { RequestHandler } from "express";
import { OFREP } from "@udp/config";

/**
 * CORS cho `/ofrep/*` — và CHỈ ở đó [v4.6].
 *
 * Phần còn lại của Service 2 không phục vụ trình duyệt; OFREP thì có: khoá CLIENT
 * nằm trong trình duyệt và gọi thẳng S2 từ domain của KHÁCH (§6.2, ADR-03). Không
 * biết trước domain nào, nên `*` — an toàn vì không có credential nào đi kèm:
 * không cookie, không `Allow-Credentials`; khoá CLIENT công khai theo thiết kế.
 *
 * Preflight trả 204 NGAY tại đây, trước limiter và trước parser: nó không mang
 * body và không mang khoá.
 */
export const ofrepCors: RequestHandler = (req, res, next) => {
  res.set({
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Expose-Headers": "ETag, Retry-After",
    // helmet mặc định `same-origin` — trang của khách phải đọc được response
    "Cross-Origin-Resource-Policy": "cross-origin",
  });
  if (req.method === "OPTIONS") {
    res.set({
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers":
        "Authorization, Content-Type, If-None-Match",
      "Access-Control-Max-Age": String(OFREP.corsMaxAgeSeconds),
    });
    res.status(204).end();
    return;
  }
  next();
};
