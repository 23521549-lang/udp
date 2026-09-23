import express, { Router, type Request } from "express";
import { SEGMENT } from "@udp/config";
import {
  jsonTooLargeHandler,
  normalizedPathOf,
  validateBody,
  validateQuery,
} from "@udp/http";
import { API_PREFIX } from "../../core/http/api-prefix.js";
import { requireAuth } from "../../core/http/middlewares/auth.middleware.js";
import { requireMinProjectRole } from "../../core/http/middlewares/project-role.middleware.js";
import {
  createSegment,
  deleteSegment,
  getSegment,
  listSegments,
  updateSegment,
} from "./segment.controller.js";
import {
  createSegmentBodySchema,
  listSegmentsQuerySchema,
  updateSegmentBodySchema,
} from "./segment.types.js";

/**
 * Segment ở Service 1 (§3.1, L6), gắn dưới `/projects/:id`.
 *
 * File này là NGUỒN DUY NHẤT của đường dẫn segment (R8, V15): router gắn route
 * theo các chuỗi dưới đây, và `isSegmentWriteRequest` — thứ `app.ts` dùng để chừa
 * đường ghi ra khỏi parser toàn cục — khớp theo cùng những chuỗi ấy. Khai ở hai
 * file là để hai bên trôi khỏi nhau, và lệch theo chiều "thêm route ghi mà quên
 * vị từ" đi vào production im lặng: body 16 MiB hợp lệ nhận 413 từ parser 1 MB.
 *
 * Quyền theo ma trận §2.2 và L6: đọc VIEWER; POST và DELETE DEVELOPER; PUT
 * MAINTAINER. PUT cao hơn vì segment dùng chung MỌI environment — đổi `userIds`
 * của một segment mà rule production đang dùng là đổi ai nhận gì ở production,
 * đúng thứ DEVELOPER không được làm trên rule production (R08 (a)). Đây cũng là
 * phương án KHÔNG có TOCTOU: kiểm "segment này có được rule prod dùng không" rồi
 * mới quyết mức quyền là kiểm ngoài khoá, và một rule prod thêm vào ngay sau đó
 * làm câu trả lời sai.
 *
 * Thứ tự middleware của hai route ghi mang ý nghĩa an ninh, không phải phong
 * cách (V14, INV-23.8): `requireAuth` → `requireMinProjectRole` → parser 16 MiB.
 * Parse 16 MiB tốn khoảng 100 ms; đặt parser trước guard là cho người vô danh
 * kích 100 ms CPU của Service 1 bằng một request.
 */
export const segmentRouter: Router = Router({ mergeParams: true });

/** Đường dẫn con của bộ sưu tập segment — xem khối chú thích trên */
const SEGMENTS_PATH = "/segments";

/**
 * `POST|PUT /api/v1/projects/:id/segments(/:segmentId)?` trên đường dẫn đã CHUẨN
 * HOÁ (lowercase, bỏ `/` cuối).
 *
 * Chỉ POST và PUT: DELETE không mang thân nên không có gì để chừa ra.
 * `[^/]+` chứ không phải mẫu UUID: vị từ trả lời "request này có đi tới route ghi
 * segment không", và Express đưa cả `/projects/abc/segments` tới đó (rồi
 * `requireMinProjectRole` trả 400). Vị từ hẹp hơn Express nghĩa là body vẫn bị
 * parse trước guard ở đúng những đường dẫn sai hình.
 */
const WRITE_PATH = new RegExp(
  `^${API_PREFIX}/projects/[^/]+${SEGMENTS_PATH}(/[^/]+)?$`,
);

export const isSegmentWriteRequest = (req: Request): boolean =>
  (req.method === "POST" || req.method === "PUT") &&
  WRITE_PATH.test(normalizedPathOf(req));

/** Parser RIÊNG của đường ghi — một instance dùng chung cho cả hai route */
const segmentBody = express.json({ limit: SEGMENT.writeBodyLimitBytes });

segmentRouter.get(
  "/segments",
  requireAuth,
  requireMinProjectRole("VIEWER"),
  validateQuery(listSegmentsQuerySchema),
  listSegments,
);

segmentRouter.post(
  "/segments",
  requireAuth,
  requireMinProjectRole("DEVELOPER"),
  segmentBody,
  validateBody(createSegmentBodySchema),
  createSegment,
);

segmentRouter.get(
  "/segments/:segmentId",
  requireAuth,
  requireMinProjectRole("VIEWER"),
  getSegment,
);

segmentRouter.put(
  "/segments/:segmentId",
  requireAuth,
  requireMinProjectRole("MAINTAINER"),
  segmentBody,
  validateBody(updateSegmentBodySchema),
  updateSegment,
);

segmentRouter.delete(
  "/segments/:segmentId",
  requireAuth,
  requireMinProjectRole("DEVELOPER"),
  deleteSegment,
);

segmentRouter.use(
  jsonTooLargeHandler(
    `Body ghi segment vượt ${String(SEGMENT.writeBodyLimitBytes)} byte`,
  ),
);
