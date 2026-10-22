import express, { Router } from "express";
import { SDK_STATS } from "@udp/config";
import { etagOf } from "@udp/flag-evaluator";
import {
  asyncHandler,
  buildProblem,
  jsonTooLargeHandler,
  logger,
  rateLimitProblemHandler,
  sendProblem,
  validateBody,
} from "@udp/http";
import { sdkStatsReportSchema, type SdkStatsReport } from "@udp/shared-types";
import {
  sdkPerKeyLimiter,
  sdkStatsLimiter,
  sdkStreamOpenLimiter,
} from "../auth/rate-limit.js";
import { requireSdkKey, sdkKeyOf } from "../auth/sdk-key.guard.js";
import { configCache } from "../changefeed/index.js";
import { sdkConfigBuffer } from "./config-body.js";
import { metrics } from "../core/metrics.js";
import { CONFIG_CACHE_HEADERS } from "./config-version.js";
import { sseHub, statsIngest } from "./index.js";
import { parseCursor } from "./sse.protocol.js";

/**
 * Bề mặt SDK (§9).
 *
 * Tách khỏi `internal/` vì hai mặt tiền này khác nhau ở mọi trục: người gọi
 * (ứng dụng của khách so với S1/S3), cách xác thực (SDK key so với bí mật dùng
 * chung), và hình dạng dữ liệu (payload đã chiếu sang hình dạng dây so với
 * resource nghiệp vụ). Trộn chúng vào một router là mời một `next()` đi nhầm
 * nhánh guard.
 */
export const sdkRouter: Router = Router();

/**
 * `GET /sdk/config` — snapshot đầy đủ cho SERVER key.
 *
 * Thứ tự middleware ở đây mang ý nghĩa an ninh, không phải phong cách:
 *
 * 1. **Rate limit trước.** Khoá đếm lấy từ header nên không cần database; đặt
 *    sau guard thì mỗi request bị chặn vẫn phải trả tiền cho một truy vấn ~52ms,
 *    tức là kẻ dội vẫn đạt được điều nó muốn. MỘT limiter thôi: 100/phút/khoá
 *    là hạn mức của SERVER key theo §2.2, còn 600/phút/(khoá, IP) thuộc về CLIENT
 *    key trên OFREP.
 * 2. **Guard, chỉ nhận `SERVER`.** §9 viết thẳng: "CHỈ cấp cho SERVER key.
 *    CLIENT key không bao giờ chạm endpoint này (ADR-03)". Khoá CLIENT dùng
 *    OFREP và nhận kết quả đã đánh giá — không rule nào rời server (I11, T1).
 * 3. **Handler mỏng.** Không truy vấn nào ở đây: mọi thứ đến từ cache, và cache
 *    là nơi duy nhất biết cách đọc một bộ ba nhất quán.
 */
sdkRouter.get(
  "/config",
  sdkPerKeyLimiter,
  requireSdkKey("SERVER"),
  asyncHandler(async (req, res) => {
    const { environmentId, keyType } = sdkKeyOf(req);
    const entry = await configCache.get(environmentId, keyType);

    res.set(CONFIG_CACHE_HEADERS);
    res.set("ETag", etagOf(entry.configVersion));

    /**
     * KHÔNG tự kiểm `If-None-Match`: Express đã làm, và làm đúng hơn.
     *
     * `res.send` so `req.fresh` — phép so đó theo chuẩn là so YẾU, xử lý được cả
     * danh sách nhiều tag lẫn tiền tố `W/`. Viết tay một phép so `===` ở đây sẽ
     * trượt ở đúng những ca đó, và trượt về phía "luôn trả 200", tức là im lặng.
     *
     * [v4.9] `send(Buffer)` chứ không `json(object)`: body đã là byte và được nhớ
     * theo bộ ba (`sdkConfigBuffer`), nên ca 304 — vốn vẫn phải có body để tầng
     * framework quyết — không còn tuần tự hoá lại tới 4 MiB (V21). Thứ ra dây
     * không đổi: `res.type` đặt đúng `application/json; charset=utf-8` như
     * `res.json`, và `Content-Length` lấy từ chính Buffer.
     */
    // Byte của body 200 cho `/metrics` (E4); 304 không có body
    res.once("finish", () => {
      if (res.statusCode === 200) {
        metrics.sdkConfigBytes.inc(
          Number(res.getHeader("Content-Length") ?? 0),
        );
      }
    });
    res.type("application/json").send(sdkConfigBuffer(entry));
  }),
);

/**
 * `GET /sdk/stream` — đường ĐẨY của SERVER key (§6.3).
 *
 * Cùng thứ tự middleware với `/config` và cùng lý do, với một khác biệt: limiter
 * là bucket RIÊNG cho việc MỞ stream — xem `sdkStreamOpenLimiter`.
 *
 * Con trỏ được đọc SAU guard: 400 chỉ dành cho người đã xác thực, không thành một
 * cách dò endpoint. Mọi thứ còn lại — giữ chỗ, header, luật con trỏ, sự kiện —
 * là việc của hub; handler chỉ dịch kết cục "từ chối" thành problem+json.
 */
sdkRouter.get(
  "/stream",
  sdkStreamOpenLimiter,
  requireSdkKey("SERVER"),
  asyncHandler(async (req, res) => {
    const cursor = parseCursor(req.get("Last-Event-ID"), req.query["since"]);
    const result = await sseHub.open(res, sdkKeyOf(req), cursor);
    if (result.kind === "accepted") return;

    res.set("Retry-After", String(result.retryAfterSeconds));
    if (result.status === 429) {
      rateLimitProblemHandler(req, res);
      return;
    }
    sendProblem(
      res,
      buildProblem({
        req,
        status: 503,
        title: "Service unavailable",
        detail: "Replica đang tắt — nối lại sau Retry-After giây",
        typeSlug: "unavailable",
      }),
    );
  }),
);

/**
 * [v4.9] `POST /sdk/stats` — telemetry của SERVER key (§6.8, V15).
 *
 * Router RIÊNG, và lý do nằm ở thứ tự mount: `app.ts` gắn nó TRƯỚC
 * `express.json({limit:"1mb"})` toàn cục, đúng khuôn OFREP. Mount sau thì parser
 * toàn cục đã đọc xong body trước khi tới đây — đã đo (R7 V4): body 2 MB nhận
 * 413 `entity.too.large` và parser riêng của route KHÔNG bao giờ chạy. Router
 * `/sdk` cũ (config, stream) giữ nguyên chỗ sau parser toàn cục: body của nó là
 * rỗng.
 *
 * Middleware gắn trên CHÍNH route, không `router.use`: router này mount ở `/sdk`
 * nên một `use` sẽ chạy cho cả `/sdk/config` và `/sdk/stream`.
 */
export const sdkStatsRouter: Router = Router();

/**
 * Thứ tự middleware mang ý nghĩa an ninh, không phải phong cách (INV-23.8):
 *
 * 1. **Đang tắt máy ⇒ 503 ngay.** Sau tín hiệu dừng, số đếm nhận thêm sẽ không
 *    kịp xuống database; nhận rồi mất im lặng là đếm THIẾU, còn 503 thì provider
 *    giữ lô và gửi lại cho replica khác (V7).
 * 2. **Rate limit.** Khoá đếm lấy từ header nên không chạm database; đặt sau
 *    guard thì mỗi request bị chặn vẫn phải trả tiền cho một truy vấn ~52 ms.
 * 3. **Guard, CHỈ `SERVER`.** Khoá CLIENT nằm trong trình duyệt nên ai cũng đọc
 *    được; cho nó gửi stats là cho người lạ bơm số để chặn archive vĩnh viễn
 *    (R17). Lượt của CLIENT do chính Service 2 đếm ở OFREP.
 * 4. **Parser riêng 2 MiB.** Body chỉ được đọc SAU khi biết người gửi là ai.
 * 5. Validate rồi 202: số chưa được ghi lúc trả lời (flush 15 giây), nên 202
 *    chứ không 204.
 */
sdkStatsRouter.post(
  "/stats",
  (req, res, next) => {
    if (!statsIngest.closing) {
      next();
      return;
    }
    res.set("Retry-After", "5");
    sendProblem(
      res,
      buildProblem({
        req,
        status: 503,
        title: "Service unavailable",
        detail: "Replica đang tắt — gửi lại sau Retry-After giây",
        typeSlug: "unavailable",
      }),
    );
  },
  sdkStatsLimiter,
  requireSdkKey("SERVER"),
  express.json({ limit: SDK_STATS.report.maxBodyBytes }),
  validateBody(sdkStatsReportSchema),
  asyncHandler(async (req, res) => {
    const report = req.body as SdkStatsReport;
    const { environmentId } = sdkKeyOf(req);
    const result = await statsIngest.acceptReport(environmentId, report.counts);

    metrics.statsReports.inc();
    logger.debug(
      { environmentId, sdk: report.sdk, ...result },
      "Đã nhận báo cáo số đếm đánh giá",
    );
    res.status(202).json(result);
  }),
);

sdkStatsRouter.use(
  jsonTooLargeHandler(
    `Báo cáo vượt ${String(SDK_STATS.report.maxBodyBytes)} byte — chia nhỏ trước khi gửi`,
  ),
);
