import { Router, type Request } from "express";
import { asyncHandler, validateBody } from "@udp/http";
import { actorOf, requireInternalCaller } from "../auth/internal-auth.guard.js";
import { uuidParam } from "../core/uuid.js";
import * as flagService from "../modules/flag/flag.service.js";
import {
  createFlagSchema,
  updateFlagSchema,
} from "../modules/flag/flag.types.js";

/**
 * Endpoint nội bộ cho flag (§9).
 *
 * Tách khỏi `modules/flag/` theo đúng cây §3.2: `flag/` giữ nghiệp vụ và truy
 * cập dữ liệu, `internal/` giữ đường dẫn và hợp đồng HTTP. Cùng một nghiệp vụ
 * sau này sẽ có thêm hai mặt tiền nữa — `/sdk/*` và OFREP — nên trộn route vào
 * module nghiệp vụ là tự đóng đường.
 */
export const internalFlagRouter: Router = Router();

/** Kiểm UUID trước khi chạm Prisma — lý do nằm ở `core/uuid.ts` */
const flagIdOf = (req: Request): string =>
  uuidParam(req, "id", "Mã flag không hợp lệ");

internalFlagRouter.post(
  "/flags",
  requireInternalCaller,
  validateBody(createFlagSchema),
  asyncHandler(async (req, res) => {
    const flag = await flagService.create(req.body, actorOf(req));
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
      actorOf(req),
    );
    res.json({ flag });
  }),
);
