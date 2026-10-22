import express, { Router } from "express";
import { SEGMENT } from "@udp/config";
import {
  asyncHandler,
  jsonTooLargeHandler,
  uuidParam,
  validateBody,
  validateQuery,
} from "@udp/http";
import {
  auditContextOf,
  requireInternalCaller,
} from "../auth/internal-auth.guard.js";
import * as segmentService from "../modules/segment/segment.service.js";
import {
  createSegmentSchema,
  segmentProjectQuerySchema,
  updateSegmentSchema,
  type SegmentProjectQuery,
} from "../modules/segment/segment.types.js";

/**
 * Đường ghi segment (§3.2, §9).
 *
 * Router này mount ở `app.ts` TRƯỚC parser 1 MB toàn cục, đúng khuôn OFREP và
 * `POST /sdk/stats`: nó có parser RIÊNG với trần `internalBodyLimitBytes`, và
 * parser đó chỉ chạy SAU `requireInternalCaller`. Mount sau parser toàn cục thì
 * một body hợp lệ sát trần nhận 413 ở 1 MB (mà Service 1 không relay 413, nên
 * người dùng thấy 500), còn body của người lạ vẫn bị đọc trước khi ai kiểm bí
 * mật nội bộ (V15, INV-23.8).
 *
 * Ba route dùng CHUNG một instance parser: `express.json` không giữ trạng thái
 * giữa các request, và một instance cho mỗi route là ba bộ đệm cấu hình y hệt
 * nhau.
 */
export const internalSegmentRouter: Router = Router();

const segmentBody = express.json({ limit: SEGMENT.internalBodyLimitBytes });

const segmentIdOf = (req: express.Request): string =>
  uuidParam(req, "id", "Mã segment không hợp lệ");

const projectIdOf = (req: express.Request): string =>
  (req.query as unknown as SegmentProjectQuery).projectId;

internalSegmentRouter.post(
  "/segments",
  requireInternalCaller,
  segmentBody,
  validateBody(createSegmentSchema),
  asyncHandler(async (req, res) => {
    const segment = await segmentService.create(req.body, auditContextOf(req));
    res.status(201).json({ segment });
  }),
);

/**
 * `validateQuery` TRƯỚC parser thân: `projectId` là phép kiểm sở hữu (R05), và
 * một request thiếu nó không đáng được parse tới 16 MiB.
 */
internalSegmentRouter.put(
  "/segments/:id",
  requireInternalCaller,
  validateQuery(segmentProjectQuerySchema),
  segmentBody,
  validateBody(updateSegmentSchema),
  asyncHandler(async (req, res) => {
    const segment = await segmentService.update(
      segmentIdOf(req),
      projectIdOf(req),
      req.body,
      auditContextOf(req),
    );
    res.json({ segment });
  }),
);

/** DELETE không có parser: nó không mang thân */
internalSegmentRouter.delete(
  "/segments/:id",
  requireInternalCaller,
  validateQuery(segmentProjectQuerySchema),
  asyncHandler(async (req, res) => {
    const segment = await segmentService.remove(
      segmentIdOf(req),
      projectIdOf(req),
      auditContextOf(req),
    );
    res.json({ segment });
  }),
);

internalSegmentRouter.use(
  jsonTooLargeHandler(
    `Body ghi segment vượt ${String(SEGMENT.internalBodyLimitBytes)} byte`,
  ),
);
