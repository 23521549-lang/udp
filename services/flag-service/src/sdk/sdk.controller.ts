import { Router } from "express";
import {
  asyncHandler,
  buildProblem,
  rateLimitProblemHandler,
  sendProblem,
} from "@udp/http";
import { sdkPerKeyLimiter, sdkStreamOpenLimiter } from "../auth/rate-limit.js";
import { requireSdkKey, sdkKeyOf } from "../auth/sdk-key.guard.js";
import { configCache } from "../changefeed/index.js";
import { sdkConfigBody } from "./config-body.js";
import { CONFIG_CACHE_HEADERS, etagOf } from "./config-version.js";
import { sseHub } from "./index.js";
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
     * `res.json` gọi `res.send`, bên trong so `req.fresh` — phép so đó theo
     * chuẩn là so YẾU, xử lý được cả danh sách nhiều tag lẫn tiền tố `W/`. Viết
     * tay một phép so `===` ở đây sẽ trượt ở đúng những ca đó, và trượt về phía
     * "luôn trả 200", tức là im lặng.
     *
     * Body vẫn được dựng trong cả hai ca. Đó là cái giá của 304 ở tầng framework
     * và nó chấp nhận được: phần đắt là truy vấn database, mà phần đó đã nằm
     * trong cache rồi. Thứ 304 tiết kiệm là băng thông — đúng điều §6.3 nhắm tới
     * khi nói "chi phí gần bằng 0".
     */
    res.json(sdkConfigBody(entry));
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
