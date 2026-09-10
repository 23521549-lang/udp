import { Router } from "express";
import { asyncHandler, validateBody } from "@udp/http";
import { actorOf, requireInternalCaller } from "../auth/internal-auth.guard.js";
import { uuidParam } from "../core/uuid.js";
import { parseFencingToken } from "../modules/rule/fencing.js";
import * as rampService from "../modules/rule/ramp.service.js";
import * as ruleService from "../modules/rule/rule.service.js";
import {
  rampRuleSchema,
  replaceRulesSchema,
} from "../modules/rule/rule.types.js";

/**
 * Đường ghi rule (§9).
 *
 * `PUT /flag-envs/:id/rules` là của Service 1 — người dùng sửa rule trên
 * Portal. `PATCH /rules/:ruleId` là của Service 3 — rollout ramp trọng số. Hai
 * đường ghi cùng một bảng nhưng khác hẳn nhau về bên gọi, về điều kiện được
 * phép, và về `change_type` ghi xuống sổ.
 */
export const internalRuleRouter: Router = Router();

internalRuleRouter.put(
  "/flag-envs/:id/rules",
  requireInternalCaller,
  validateBody(replaceRulesSchema),
  asyncHandler(async (req, res) => {
    const result = await ruleService.replaceRules(
      uuidParam(req, "id", "Mã cấu hình flag theo environment không hợp lệ"),
      req.body,
      actorOf(req),
    );
    res.json(result);
  }),
);

/**
 * Bóc `If-Match` TRƯỚC khi chạm database, cùng lý do với kiểm UUID: token sai
 * dạng là request sai hình dạng (400), không phải một lần fencing thất bại (412).
 *
 * Không có `actorOf(req)`: lần ghi này không của người dùng nào (§2.2).
 */
internalRuleRouter.patch(
  "/rules/:ruleId",
  requireInternalCaller,
  validateBody(rampRuleSchema),
  asyncHandler(async (req, res) => {
    const result = await rampService.rampRule(
      uuidParam(req, "ruleId", "Mã rule không hợp lệ"),
      parseFencingToken(req.get("If-Match")),
      req.body,
    );
    res.json(result);
  }),
);
