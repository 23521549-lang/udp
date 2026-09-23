import { Router } from "express";
import { asyncHandler, uuidParam, validateQuery } from "@udp/http";
import { requireInternalCaller } from "../auth/internal-auth.guard.js";
import * as statsService from "../modules/stats/stats.service.js";
import {
  internalFlagStatsQuerySchema,
  internalStaleFlagsQuerySchema,
  internalStatsSummaryQuerySchema,
  type InternalFlagStatsQuery,
  type InternalStaleFlagsQuery,
  type InternalStatsSummaryQuery,
} from "../modules/stats/stats.types.js";

/**
 * [v4.9] Ba route ĐỌC telemetry (§3.2) — tên của hai route đầu đã nằm trong thiết
 * kế từ v4 (design:5189-5190), nay được hiện thực.
 *
 * KHÔNG đòi `X-Udp-Actor-Id`: chúng chỉ đọc, nên không có hàng audit nào cần biết
 * ai hỏi (cùng lý lẽ với `/internal/flags/:id/evaluate`). Vẫn qua
 * `requireInternalCaller` — số lượt đánh giá của một project là dữ liệu của khách.
 *
 * Router RIÊNG chứ không gắn thêm vào `internalFlagRouter`: `flag/` giữ nghiệp vụ
 * ghi cấu hình, `stats/` giữ đường đọc telemetry, và hai thứ có nhịp thay đổi khác
 * nhau. Thứ tự mount không quan trọng ở đây — `internalFlagRouter` không khai
 * route GET nào trùng hình với ba đường dưới.
 */
export const internalStatsRouter: Router = Router();

internalStatsRouter.get(
  "/flags/:id/stats",
  requireInternalCaller,
  validateQuery(internalFlagStatsQuerySchema),
  asyncHandler(async (req, res) => {
    res.json(
      await statsService.flagStats(
        uuidParam(req, "id", "Mã flag không hợp lệ"),
        req.query as unknown as InternalFlagStatsQuery,
      ),
    );
  }),
);

internalStatsRouter.get(
  "/stale-flags",
  requireInternalCaller,
  validateQuery(internalStaleFlagsQuerySchema),
  asyncHandler(async (req, res) => {
    res.json(
      await statsService.staleFlags(
        req.query as unknown as InternalStaleFlagsQuery,
      ),
    );
  }),
);

internalStatsRouter.get(
  "/flag-stats/summary",
  requireInternalCaller,
  validateQuery(internalStatsSummaryQuerySchema),
  asyncHandler(async (req, res) => {
    res.json(
      await statsService.summary(
        req.query as unknown as InternalStatsSummaryQuery,
      ),
    );
  }),
);
