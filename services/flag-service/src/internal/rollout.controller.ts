import { Router } from "express";
import { asyncHandler } from "@udp/http";
import { requireInternalCaller } from "../auth/internal-auth.guard.js";
import { uuidParam } from "../core/uuid.js";
import * as rolloutService from "../modules/rollout/rollout.service.js";

/**
 * Gắn/gỡ nhãn `ff` của rollout FLAG_LEVEL (§6.6, §9 [v4.3]).
 *
 * Hai đường, không nhận body:
 *   - `POST /rollouts/:sessionId/track` — Service 1, lúc tạo rollout.
 *   - `POST /flag-envs/:id/untrack` — Service 3, khi rollout kết thúc và ở lưới
 *     quét. Theo CONFIG chứ không theo session: phải chạy được cả khi hàng
 *     session đã bị xoá, và S3 luôn biết `flag_env_config_id` của session.
 *
 * Không có `actorOf(req)`: đây không phải lần sửa cấu hình của người dùng
 * (§2.2 "NULL = Service 3 khi rollout"), kể cả khi S1 là bên gọi `track`.
 */
export const internalRolloutRouter: Router = Router();

const SESSION_ID = "Mã rollout session không hợp lệ";

internalRolloutRouter.post(
  "/rollouts/:sessionId/track",
  requireInternalCaller,
  asyncHandler(async (req, res) => {
    res.json(
      await rolloutService.track(uuidParam(req, "sessionId", SESSION_ID)),
    );
  }),
);

internalRolloutRouter.post(
  "/flag-envs/:id/untrack",
  requireInternalCaller,
  asyncHandler(async (req, res) => {
    res.json(
      await rolloutService.untrackConfig(
        uuidParam(req, "id", "Mã cấu hình flag theo environment không hợp lệ"),
      ),
    );
  }),
);
