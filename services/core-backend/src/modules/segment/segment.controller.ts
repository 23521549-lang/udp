import type { Request, RequestHandler } from "express";
import { asyncHandler, sendJson, uuidParam } from "@udp/http";
import {
  segmentListResponseWire,
  segmentResponseWire,
} from "@udp/shared-types/wire";
import { appDepsOf } from "../../core/app-deps.js";
import { projectIdParam } from "../../core/http/middlewares/project-role.middleware.js";
import { auditContextOf } from "../audit/audit.service.js";
import * as segmentService from "./segment.service.js";
import type { CreateSegmentBody, UpdateSegmentBody } from "./segment.types.js";

/**
 * Handler của năm route segment (§3.1).
 *
 * Tách khỏi `segment.routes.ts` vì file kia phải giữ được MỘT việc: khai đường
 * dẫn và guard của chúng ở một chỗ, nơi `isSegmentWriteRequest` đọc cùng chuỗi
 * mà router gắn (V15), và nơi lint I10 đọc được chuỗi middleware.
 *
 * Handler ở đây không kiểm quyền và không kiểm sở hữu: quyền là việc của guard
 * trong `segment.routes.ts`, sở hữu `:segmentId` là việc của service (nó phải
 * nằm trong cùng câu truy vấn đọc segment, không phải một bước rời).
 */

const segmentIdOf = (req: Request): string =>
  uuidParam(req, "segmentId", "Mã segment không hợp lệ");

export const listSegments: RequestHandler = asyncHandler(async (req, res) => {
  sendJson(
    res,
    segmentListResponseWire,
    await segmentService.list(projectIdParam(req), req.query),
  );
});

export const getSegment: RequestHandler = asyncHandler(async (req, res) => {
  sendJson(res, segmentResponseWire, {
    segment: await segmentService.get(projectIdParam(req), segmentIdOf(req)),
  });
});

export const createSegment: RequestHandler = asyncHandler(async (req, res) => {
  const segment = await segmentService.create(
    appDepsOf(req),
    projectIdParam(req),
    req.body as CreateSegmentBody,
    auditContextOf(req),
  );
  sendJson(res, segmentResponseWire, { segment }, 201);
});

export const updateSegment: RequestHandler = asyncHandler(async (req, res) => {
  sendJson(res, segmentResponseWire, {
    segment: await segmentService.update(
      appDepsOf(req),
      projectIdParam(req),
      segmentIdOf(req),
      req.body as UpdateSegmentBody,
      auditContextOf(req),
    ),
  });
});

export const deleteSegment: RequestHandler = asyncHandler(async (req, res) => {
  await segmentService.remove(
    appDepsOf(req),
    projectIdParam(req),
    segmentIdOf(req),
    auditContextOf(req),
  );
  res.status(204).end();
});
