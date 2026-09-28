import { Router, type Request } from "express";
import { asyncHandler, uuidParam, validateBody } from "@udp/http";
import {
  auditContextOf,
  requireInternalCaller,
} from "../auth/internal-auth.guard.js";
import { evaluateForTester } from "../modules/flag/evaluate.service.js";
import * as flagService from "../modules/flag/flag.service.js";
import {
  createFlagSchema,
  evaluateFlagSchema,
  replaceVariantsSchema,
  updateFlagSchema,
  type EvaluateFlagInput,
  type ReplaceVariantsInput,
} from "../modules/flag/flag.types.js";
import { replaceVariants } from "../modules/flag/variant.service.js";

/**
 * Endpoint nội bộ cho flag (§9).
 *
 * Tách khỏi `modules/flag/` theo đúng cây §3.2: `flag/` giữ nghiệp vụ và truy
 * cập dữ liệu, `internal/` giữ đường dẫn và hợp đồng HTTP. Cùng một nghiệp vụ
 * sau này sẽ có thêm hai mặt tiền nữa — `/sdk/*` và OFREP — nên trộn route vào
 * module nghiệp vụ là tự đóng đường.
 */
export const internalFlagRouter: Router = Router();

/** Kiểm UUID trước khi chạm Prisma — lý do nằm ở `uuid.ts` của `@udp/http` */
const flagIdOf = (req: Request): string =>
  uuidParam(req, "id", "Mã flag không hợp lệ");

internalFlagRouter.post(
  "/flags",
  requireInternalCaller,
  validateBody(createFlagSchema),
  asyncHandler(async (req, res) => {
    const flag = await flagService.create(req.body, auditContextOf(req));
    res.status(201).json({ flag });
  }),
);

internalFlagRouter.patch(
  "/flags/:id",
  requireInternalCaller,
  validateBody(updateFlagSchema),
  asyncHandler(async (req, res) => {
    const flag = await flagService.update(
      flagIdOf(req),
      req.body,
      auditContextOf(req),
    );
    res.json({ flag });
  }),
);

/**
 * [v4.11, Plan #44] Thay toàn bộ danh sách variant — đòi người làm như bốn route ghi flag: S2 ghi
 * hàng audit `flag.variants.update` trong transaction của thay đổi (I40).
 */
internalFlagRouter.put(
  "/flags/:id/variants",
  requireInternalCaller,
  validateBody(replaceVariantsSchema),
  asyncHandler(async (req, res) => {
    const flag = await replaceVariants(
      flagIdOf(req),
      req.body as ReplaceVariantsInput,
      auditContextOf(req),
    );
    res.json({ flag });
  }),
);

/**
 * [v4.6] Flag Evaluation Tester — chỉ đọc, nên không đòi người làm (không audit):
 * đánh giá thử không đổi gì.
 */
internalFlagRouter.post(
  "/flags/:id/evaluate",
  requireInternalCaller,
  validateBody(evaluateFlagSchema),
  asyncHandler(async (req, res) => {
    const body = req.body as EvaluateFlagInput;
    res.json(
      await evaluateForTester(flagIdOf(req), body.environmentId, body.context),
    );
  }),
);
