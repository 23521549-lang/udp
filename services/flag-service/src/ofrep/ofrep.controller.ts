import { createHash } from "node:crypto";
import express, {
  Router,
  type ErrorRequestHandler,
  type Request,
  type Response,
} from "express";
import { OFREP } from "@udp/config";
import {
  canonicalJson,
  EVALUATOR_SEMANTICS_VERSION,
  evaluate,
  evaluateAll,
  ofrepFlagNotFound,
  toOfrep,
} from "@udp/flag-evaluator";
import { AppError, asyncHandler, logger } from "@udp/http";
import {
  ofrepContextIssue,
  ofrepRequestSchema,
  type OfrepBulkFailure,
  type OfrepBulkResponse,
  type OfrepEvaluationErrorCode,
  type OfrepFailure,
} from "@udp/shared-types";
import { ofrepPerIpLimiter, ofrepPerKeyIpLimiter } from "../auth/rate-limit.js";
import { requireSdkKey, sdkKeyOf } from "../auth/sdk-key.guard.js";
import { configCache } from "../changefeed/index.js";
import { preparedOf } from "../evaluation/prepared-cache.js";
import { ofrepCors } from "./cors.js";
import { createResultCache } from "./result-cache.js";

/**
 * OFREP — đánh giá từ xa cho CLIENT key (§6.2, ADR-03) [v4.6], theo openapi của
 * open-feature/protocol.
 *
 * Không rule nào rời server: trình duyệt gửi context, nhận `value`/`variant`/
 * `reason` — không `ruleId`, không id environment (I11). Cùng MỘT hàm đánh giá
 * với SDK local (I26), trên snapshot CLIENT mà watcher ba tầng giữ tươi.
 *
 * Thứ tự: CORS (preflight trả ngay) → trần theo IP → trần (khoá, IP) → parser
 * RIÊNG 16 KB (router này mount TRƯỚC parser 1 MB toàn cục) → tra khoá → handler.
 * Mọi thứ trước bước tra khoá đều không chạm database.
 */
export const ofrepRouter: Router = Router();

ofrepRouter.use(ofrepCors);
ofrepRouter.use(ofrepPerIpLimiter);
ofrepRouter.use(ofrepPerKeyIpLimiter);
ofrepRouter.use(express.json({ limit: OFREP.bodyLimit }));

const bulkResults = createResultCache({
  maxEntries: OFREP.resultCacheEntries,
  maxBytes: OFREP.resultCacheBytes,
});

/** Lỗi 400 mang đúng hình OFREP — single có `key`, bulk thì không */
class OfrepRequestError extends Error {
  constructor(
    readonly errorCode: OfrepEvaluationErrorCode,
    readonly errorDetails: string,
  ) {
    super(errorDetails);
  }
}

function contextOf(req: Request): Record<string, unknown> {
  const parsed = ofrepRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    throw new OfrepRequestError(
      "PARSE_ERROR",
      "Body phải là { context: {...} }",
    );
  }
  const issue = ofrepContextIssue(parsed.data.context);
  if (issue !== undefined)
    throw new OfrepRequestError("INVALID_CONTEXT", issue);
  return parsed.data.context;
}

const sha256 = (text: string): string =>
  createHash("sha256").update(text).digest("hex");

/**
 * ETag của bulk: MỘT hàm của (environment, `configVersion`, ngữ nghĩa evaluator,
 * context). Chỉ `configVersion` thì client đổi context mà giữ `If-None-Match`
 * cũ sẽ nhận 304 cho kết quả của NGƯỜI KHÁC. `canonicalJson` chuẩn hoá NFC —
 * cùng luật lõi đánh giá áp cho context, nên hai context cùng ETag luôn cùng kết
 * quả.
 */
function bulkKeyOf(
  environmentId: string,
  configVersion: number,
  context: Record<string, unknown>,
): string {
  return sha256(
    `${environmentId}:${String(configVersion)}:${String(EVALUATOR_SEMANTICS_VERSION)}:${canonicalJson(context)}`,
  ).slice(0, 32);
}

/**
 * `If-None-Match` có chứa ĐÚNG tag này không — danh sách, tiền tố `W/`. KHÔNG nhận
 * `*`: với bulk, `*` sẽ là 304 cho mọi context, tức client gửi nó không bao giờ
 * nhận được dữ liệu.
 */
function matchesTag(req: Request, tag: string): boolean {
  const header = req.get("If-None-Match");
  if (header === undefined) return false;
  return header
    .split(",")
    .map((t) => t.trim().replace(/^W\//, ""))
    .includes(tag);
}

const NO_STORE = {
  "Cache-Control": "private, no-cache",
  Vary: "Authorization",
};

ofrepRouter.post(
  "/v1/evaluate/flags",
  requireSdkKey("CLIENT"),
  asyncHandler(async (req: Request, res: Response) => {
    const context = contextOf(req);
    const { environmentId } = sdkKeyOf(req);
    const entry = await configCache.get(environmentId, "CLIENT");
    let cacheKey: string;
    try {
      cacheKey = bulkKeyOf(environmentId, entry.configVersion, context);
    } catch {
      throw new OfrepRequestError(
        "INVALID_CONTEXT",
        "context chứa giá trị không phải JSON hợp lệ",
      );
    }
    const tag = `"${cacheKey}"`;
    res.set({ ...NO_STORE, ETag: tag });
    if (matchesTag(req, tag)) {
      res.status(304).end();
      return;
    }

    let body = bulkResults.get(cacheKey);
    if (body === undefined) {
      const response: OfrepBulkResponse = {
        flags: evaluateAll(preparedOf(entry), context).map(
          ({ key, evaluation }) => toOfrep(key, evaluation),
        ),
        metadata: { configVersion: entry.configVersion },
      };
      body = JSON.stringify(response);
      bulkResults.set(cacheKey, body);
    }
    res.type("application/json").send(body);
  }),
);

ofrepRouter.post(
  "/v1/evaluate/flags/:key",
  requireSdkKey("CLIENT"),
  asyncHandler(async (req: Request, res: Response) => {
    const key = req.params["key"] ?? "";
    const context = contextOf(req);
    const { environmentId } = sdkKeyOf(req);
    const entry = await configCache.get(environmentId, "CLIENT");
    const evaluation = evaluate(preparedOf(entry), key, context);

    res.set(NO_STORE);
    if (evaluation.reason === "ERROR") {
      if (evaluation.errorCode === "FLAG_NOT_FOUND") {
        res.status(404).json(ofrepFlagNotFound(key));
        return;
      }
      logger.warn(
        { flagKey: key, environmentId, errorMessage: evaluation.errorMessage },
        "OFREP: cấu hình flag không đánh giá được",
      );
      res.status(400).json(toOfrep(key, evaluation));
      return;
    }
    res.json(toOfrep(key, evaluation));
  }),
);

/** Key của endpoint đơn lấy từ path — lỗi của parser xảy ra trước khi route khớp */
function keyFromPath(path: string): string {
  const raw = path.split("/").pop() ?? "";
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

/**
 * Lỗi của CHÍNH request OFREP ra đúng hình openapi (400: single có `key`, bulk
 * thì không). JSON hỏng và body quá trần do parser ném cũng thuộc nhóm đó.
 * Mọi thứ khác (401 của guard…) đi tiếp tới `errorHandler` chung.
 */
const ofrepErrorHandler: ErrorRequestHandler = (err, req, res, next) => {
  const single = req.path !== "/v1/evaluate/flags";
  const status = (err as { status?: unknown }).status;
  // body-parser gắn `type` cho mọi lỗi của nó: JSON hỏng, charset/encoding không
  // hỗ trợ, request bị huỷ — lỗi của CLIENT, không phải của máy chủ
  const parserError =
    typeof (err as { type?: unknown }).type === "string" &&
    typeof status === "number" &&
    status >= 400 &&
    status < 500;
  let failure: OfrepRequestError | undefined;
  if (err instanceof OfrepRequestError) failure = err;
  else if (status === 413) {
    failure = new OfrepRequestError(
      "INVALID_CONTEXT",
      `Body vượt ${OFREP.bodyLimit}`,
    );
  } else if (parserError) {
    // 400 theo hình OFREP, KHÔNG log error — người lạ không được làm ngập log
    failure = new OfrepRequestError("PARSE_ERROR", "Body không đọc được");
  }
  if (failure === undefined) {
    if (err instanceof AppError) {
      next(err);
      return;
    }
    logger.error({ err }, "OFREP: lỗi không lường trước");
    res.status(500).json({ errorDetails: "Lỗi máy chủ" });
    return;
  }
  const body: OfrepFailure | OfrepBulkFailure = single
    ? {
        key: keyFromPath(req.path),
        errorCode: failure.errorCode,
        errorDetails: failure.errorDetails,
      }
    : { errorCode: failure.errorCode, errorDetails: failure.errorDetails };
  res.status(400).json(body);
};

ofrepRouter.use(ofrepErrorHandler);
