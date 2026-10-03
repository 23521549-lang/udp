import { Router } from "express";
import { asyncHandler, sendJson } from "@udp/http";
import { homeResponseWire } from "@udp/shared-types/wire";
import {
  requireAuth,
  requireUser,
} from "../../core/http/middlewares/auth.middleware.js";
import { homeOf } from "./home.service.js";

/**
 * [v4.11, Plan #53 QĐ-5] `GET /api/v1/home` — trang chủ của người đang đăng nhập.
 *
 * Không nằm dưới `/projects/:id` (không có project nào trong đường dẫn), nên không qua
 * `requireMinProjectRole`: quyền là vai hiệu lực, và `homeOf` lọc theo nó TRONG mọi truy vấn.
 */
export const homeRouter: Router = Router();

homeRouter.get(
  "/",
  requireAuth,
  asyncHandler(async (req, res) => {
    sendJson(res, homeResponseWire, {
      home: await homeOf(requireUser(req).sub),
    });
  }),
);
