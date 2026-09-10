import { Router } from "express";
import { asyncHandler, validateBody } from "@udp/http";
import { actorOf, requireInternalCaller } from "../auth/internal-auth.guard.js";
import { uuidParam } from "../core/uuid.js";
import * as envConfigService from "../modules/env-config/env-config.service.js";
import { updateEnvConfigSchema } from "../modules/env-config/env-config.types.js";

/**
 * `PATCH /internal/flag-envs/:id` — bật/tắt và default variant theo env (§9).
 *
 * Service 1 là bên gọi: nó kiểm quyền (`prod` đòi MAINTAINER và xác nhận hai
 * bước, §8.4) rồi mới gọi xuống đây. Tầng này không biết gì về vai trò người
 * dùng — nó tin lời gọi đã qua bí mật dùng chung, và chỉ ghi `X-Udp-Actor-Id`
 * vào outbox.
 */
export const internalEnvConfigRouter: Router = Router();

internalEnvConfigRouter.patch(
  "/flag-envs/:id",
  requireInternalCaller,
  validateBody(updateEnvConfigSchema),
  asyncHandler(async (req, res) => {
    const envConfig = await envConfigService.update(
      uuidParam(req, "id", "Mã cấu hình flag theo environment không hợp lệ"),
      req.body,
      actorOf(req),
    );
    res.json({ envConfig });
  }),
);
