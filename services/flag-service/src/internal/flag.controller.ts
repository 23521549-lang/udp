import { Router, type Request } from "express";
import { asyncHandler, ValidationError, validateBody } from "@udp/http";
import { actorOf, requireInternalCaller } from "../auth/internal-auth.guard.js";
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

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Chặn id sai định dạng TRƯỚC khi chạm Prisma.
 *
 * Không có bước này, một id không phải UUID đi thẳng xuống Postgres và ném
 * `22P02`, mã đó không nằm trong bảng ánh xạ của `@udp/db` nên rơi xuống nhánh
 * cuối và thành **500**. Một URL gõ sai không phải sự cố máy chủ.
 */
function flagIdOf(req: Request): string {
  const raw = req.params["id"];
  if (raw === undefined || !UUID.test(raw)) {
    throw new ValidationError("Mã flag không hợp lệ");
  }
  return raw;
}

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
