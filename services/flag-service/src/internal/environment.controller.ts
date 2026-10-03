import { Router } from "express";
import { asyncHandler, uuidParam } from "@udp/http";
import {
  auditContextOf,
  requireInternalCaller,
} from "../auth/internal-auth.guard.js";
import { backfill } from "../modules/env-config/env-config.backfill.js";

/**
 * `POST /internal/environments/:id/backfill` — [v4.11, Plan #40] Service 1 gọi SAU khi tạo một
 * environment cho project đã có flag (§4, §9). Idempotent: gọi lại là an toàn.
 */
export const internalEnvironmentRouter: Router = Router();

internalEnvironmentRouter.post(
  "/environments/:id/backfill",
  requireInternalCaller,
  asyncHandler(async (req, res) => {
    const result = await backfill(
      uuidParam(req, "id", "Mã environment không hợp lệ"),
      auditContextOf(req).actorUserId,
    );
    res.json(result);
  }),
);
