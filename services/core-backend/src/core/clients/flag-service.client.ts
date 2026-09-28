import {
  ACTOR_HEADER,
  CLIENT_IP_HEADER,
  CLIENT_UA_HEADER,
  INTERNAL_CALL,
  INTERNAL_SECRET_HEADER,
  ROLLOUT_CREATE,
} from "@udp/config";
import type { SdkKeyType } from "@udp/db";
import {
  logger,
  relayedProblemOf,
  ServiceUnavailableError,
  type AuditContext,
} from "@udp/http";
import {
  flagStatsResponseSchema,
  flagStatsSummarySchema,
  staleFlagsResponseSchema,
  trackOutcomeOf,
  type CreateFlagFields,
  type FlagStatsQuery,
  type FlagStatsResponse,
  type FlagStatsSummary,
  type ReplaceRulesFields,
  type ReplaceVariantsFields,
  type StaleFlagsQuery,
  type StaleFlagsResponse,
  testerResultSchema,
  type CreateSegmentFields,
  type TesterResult,
  type TrackOutcome,
  type UpdateEnvConfigFields,
  type UpdateFlagFields,
  type UpdateSegmentFields,
} from "@udp/shared-types";
import { z } from "zod";

export type { TrackOutcome };

/**
 * Service 1 gọi Service 2 (§9 `/internal/*`): `track` lúc tạo rollout (§8.5) và
 * bốn lời gọi GHI cấu hình flag của Luồng 4 (§8.4) [v4.5].
 *
 * Chỉ giữ phần MẠNG: hạn chờ, header (bí mật nội bộ, và cho lời gọi ghi: ai, IP,
 * UA của người dùng — Service 2 ghi audit trong transaction của nó), lỗi fetch.
 * Phân loại response là hàm thuần dùng chung: `trackOutcomeOf` với Service 3,
 * `relayedProblemOf` cho lỗi nghiệp vụ chuyển tới Portal.
 *
 * Lời gọi ghi KHÔNG trả hình nội bộ của S2 lên trên (hình đó mang `bucketSalt`,
 * id nội bộ): S1 đọc lại view của chính nó sau khi S2 commit, nên POST/PATCH trả
 * cùng hình với GET. Chỉ `createFlag` cần một thứ từ response — id flag mới.
 *
 * URL, secret và `fetch` tiêm vào để test trỏ tới S2 dựng trên cổng ngẫu nhiên.
 */
export interface FlagServiceClient {
  track(sessionId: string): Promise<TrackOutcome>;
  /** Trả id của flag vừa tạo */
  createFlag(
    body: CreateFlagFields & { projectId: string },
    ctx: AuditContext,
  ): Promise<string>;
  updateFlag(
    flagId: string,
    body: UpdateFlagFields,
    ctx: AuditContext,
  ): Promise<void>;
  updateEnvConfig(
    configId: string,
    body: UpdateEnvConfigFields,
    ctx: AuditContext,
  ): Promise<void>;
  replaceRules(
    configId: string,
    body: ReplaceRulesFields,
    ctx: AuditContext,
  ): Promise<void>;
  /** [v4.11, Plan #44] Thay toàn bộ danh sách variant của flag */
  replaceVariants(
    flagId: string,
    body: ReplaceVariantsFields,
    ctx: AuditContext,
  ): Promise<void>;
  /** [v4.6] Flag Evaluation Tester — chỉ đọc, không ngữ cảnh audit */
  evaluateFlag(
    flagId: string,
    body: { environmentId: string; context: Record<string, unknown> },
  ): Promise<TesterResult>;
  /** [v4.9] Ba lời gọi ĐỌC telemetry (§3.2) — S2 là nơi duy nhất biết SQL (V19) */
  flagStats(
    flagId: string,
    query: FlagStatsQuery & { environmentId?: string },
  ): Promise<FlagStatsResponse>;
  staleFlags(
    query: StaleFlagsQuery & { projectId: string },
  ): Promise<StaleFlagsResponse>;
  flagStatsSummary(query: {
    environmentId: string;
    flagIds: readonly string[];
    tz: string;
  }): Promise<FlagStatsSummary>;
  /**
   * [v4.9] Ba lời gọi GHI segment (§3.2). `createSegment` trả id của segment vừa
   * tạo — Service 1 đọc lại view của chính nó bằng id đó, cùng khuôn `createFlag`.
   */
  createSegment(
    body: CreateSegmentFields & { projectId: string },
    ctx: AuditContext,
  ): Promise<string>;
  /**
   * `projectId` đi bằng QUERY chứ không bằng thân, ở cả PUT và DELETE: `call`
   * không gửi thân cho DELETE (xem chú thích ở đó), nên một hình dùng chung giữ
   * thân của PUT đúng bằng `updateSegmentFields`. Nó là lớp phòng thủ thứ hai của
   * R05 — Service 2 đưa nó vào chính điều kiện đọc segment và trả 404 khi lệch.
   */
  updateSegment(
    segmentId: string,
    projectId: string,
    body: UpdateSegmentFields,
    ctx: AuditContext,
  ): Promise<void>;
  deleteSegment(
    segmentId: string,
    projectId: string,
    ctx: AuditContext,
  ): Promise<void>;
  /**
   * [v4.9] Hai lời gọi GHI SDK key (§3.2, L7).
   *
   * Thân của `createSdkKey` mang `keyHash` + `keySuffix`, KHÔNG mang token thô:
   * Service 1 sinh và giữ plaintext, Service 2 chỉ nhận thứ dẫn xuất (R04). Trả
   * về id khoá — Service 1 đọc lại view của chính nó bằng id đó, cùng khuôn
   * `createFlag` và `createSegment`.
   */
  createSdkKey(body: SdkKeyMaterialBody, ctx: AuditContext): Promise<string>;
  /** `environmentId` đi bằng QUERY — lớp phòng thủ thứ hai của R05, như segment */
  revokeSdkKey(
    keyId: string,
    environmentId: string,
    ctx: AuditContext,
  ): Promise<void>;
  /**
   * [v4.11, Plan #40] `FlagEnvConfig` TẮT cho mọi flag còn thiếu ở environment vừa tạo (§4) —
   * idempotent phía S2. Trả số hàng vừa tạo.
   */
  backfillEnvironment(
    environmentId: string,
    ctx: AuditContext,
  ): Promise<number>;
}

/** Thứ Service 2 nhận để tạo một khoá — không có trường nào mang plaintext */
export interface SdkKeyMaterialBody {
  environmentId: string;
  keyType: SdkKeyType;
  label: string | null;
  keyHash: string;
  keySuffix: string;
}

const createdFlagSchema = z.object({
  flag: z.object({ id: z.string().uuid() }),
});

const createdSegmentSchema = z.object({
  segment: z.object({ id: z.string().uuid() }),
});

const backfillSchema = z.object({ created: z.number().int().nonnegative() });

/**
 * [v4.9] Response của `POST /internal/sdk-keys` (§3.2, V4).
 *
 * `created` được parse dù Service 1 không dùng nó để rẽ nhánh: nó là phần hợp
 * đồng phân biệt "vừa INSERT" với "hàng cùng hash đã có", và một ngày Service 2
 * ngừng gửi nó thì lỗi phải nổ ở đây — không phải âm thầm biến lần thử lại thành
 * một thứ không ai kiểm được nữa.
 */
const createdSdkKeySchema = z.object({
  key: z.object({ id: z.string().uuid() }),
  created: z.boolean(),
});

export interface FlagServiceClientOptions {
  baseUrl: string;
  secret: string;
  /** Hạn chờ của `track`; lời gọi ghi cấu hình dùng `INTERNAL_CALL.configWriteTimeoutMs` */
  timeoutMs?: number;
  fetch?: typeof fetch;
}

export function createFlagServiceClient(
  options: FlagServiceClientOptions,
): FlagServiceClient {
  const baseUrl = options.baseUrl.replace(/\/+$/, "");
  const trackTimeoutMs = options.timeoutMs ?? ROLLOUT_CREATE.trackTimeoutMs;
  const fetchImpl = options.fetch ?? fetch;

  /**
   * Một lời gọi tới Service 2 (bốn lời gọi ghi cấu hình, Tester, và [v4.9] ba lời
   * gọi đọc telemetry). 2xx ⇒ body. Lỗi nghiệp vụ (404/409/422) ⇒
   * `RelayedProblemError` — Portal nhận đúng mã, `current`, `resourceId` của S2.
   * 5xx/mạng/hết giờ ⇒ 503 (thử lại có ích). Mọi status khác (400/401/403) là
   * hai service lệch hợp đồng hay cấu hình — không phải lỗi của người dùng: log
   * error, 500, KHÔNG chuyển 401 tới Portal (nó sẽ đăng xuất người dùng).
   *
   * `body === undefined` là lời gọi GET/DELETE: KHÔNG gửi `content-type` và không
   * gửi thân. Một GET mang `content-type: application/json` mà không có body là
   * lời khai sai với mọi proxy trên đường, và `fetch` từ chối `body` với GET.
   */
  async function call(
    method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE",
    path: string,
    body: object | undefined,
    ctx: AuditContext,
    purpose: "write" | "read" = "write",
  ): Promise<unknown> {
    let res: Response;
    try {
      res = await fetchImpl(`${baseUrl}${path}`, {
        method,
        headers: {
          ...(body === undefined ? {} : { "content-type": "application/json" }),
          [INTERNAL_SECRET_HEADER]: options.secret,
          ...(ctx.actorUserId === undefined
            ? {}
            : { [ACTOR_HEADER]: ctx.actorUserId }),
          ...(ctx.ip === undefined ? {} : { [CLIENT_IP_HEADER]: ctx.ip }),
          ...(ctx.userAgent === undefined
            ? {}
            : { [CLIENT_UA_HEADER]: ctx.userAgent }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(
          purpose === "write"
            ? INTERNAL_CALL.configWriteTimeoutMs
            : INTERNAL_CALL.readTimeoutMs,
        ),
      });
    } catch (err: unknown) {
      throw new ServiceUnavailableError(
        `Service 2 không phản hồi: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    const payload: unknown = await res.json().catch(() => undefined);
    if (res.ok) {
      if (typeof payload === "object" && payload !== null) return payload;
      // Lời gọi ghi: S2 đã trả 2xx — thay đổi CÓ THỂ đã commit; đừng để người dùng
      // tưởng là chưa. Lời gọi đọc: chỉ là thử lại
      throw new ServiceUnavailableError(
        `Service 2 trả HTTP ${String(res.status)} cho ${method} ${path} nhưng body không đọc được${purpose === "write" ? " — thay đổi có thể đã được áp dụng, tải lại để xem" : ""}`,
      );
    }
    const relayed = relayedProblemOf(res.status, payload);
    if (relayed !== undefined) throw relayed;
    if (res.status >= 500) {
      throw new ServiceUnavailableError(
        `Service 2 lỗi HTTP ${String(res.status)}`,
      );
    }
    logger.error(
      { status: res.status, path, body: payload },
      "Service 2 từ chối lời gọi của Service 1 — hai service lệch hợp đồng hoặc cấu hình",
    );
    throw new Error(
      `Service 2 trả HTTP ${String(res.status)} cho ${method} ${path}`,
    );
  }

  return {
    async track(sessionId) {
      try {
        const res = await fetchImpl(
          `${baseUrl}/internal/rollouts/${encodeURIComponent(sessionId)}/track`,
          {
            method: "POST",
            headers: { [INTERNAL_SECRET_HEADER]: options.secret },
            signal: AbortSignal.timeout(trackTimeoutMs),
          },
        );
        return trackOutcomeOf(
          res.status,
          await res.json().catch(() => undefined),
        );
      } catch (err: unknown) {
        return {
          status: "UNAVAILABLE",
          message: err instanceof Error ? err.message : String(err),
        };
      }
    },
    async createFlag(body, ctx) {
      const payload = await call("POST", "/internal/flags", body, ctx);
      const created = createdFlagSchema.safeParse(payload);
      if (!created.success) {
        logger.error(
          { issues: created.error.issues },
          "Service 2 tạo flag nhưng response không mang id — hai service lệch hợp đồng",
        );
        throw new Error("Response tạo flag của Service 2 sai hình");
      }
      return created.data.flag.id;
    },
    async updateFlag(flagId, body, ctx) {
      await call(
        "PATCH",
        `/internal/flags/${encodeURIComponent(flagId)}`,
        body,
        ctx,
      );
    },
    async updateEnvConfig(configId, body, ctx) {
      await call(
        "PATCH",
        `/internal/flag-envs/${encodeURIComponent(configId)}`,
        body,
        ctx,
      );
    },
    async replaceRules(configId, body, ctx) {
      await call(
        "PUT",
        `/internal/flag-envs/${encodeURIComponent(configId)}/rules`,
        body,
        ctx,
      );
    },
    async replaceVariants(flagId, body, ctx) {
      await call(
        "PUT",
        `/internal/flags/${encodeURIComponent(flagId)}/variants`,
        body,
        ctx,
      );
    },
    async evaluateFlag(flagId, body) {
      const payload = await call(
        "POST",
        `/internal/flags/${encodeURIComponent(flagId)}/evaluate`,
        body,
        {},
        "read",
      );
      return parsedOrThrow(testerResultSchema, payload, "kết quả Tester");
    },
    async flagStats(flagId, query) {
      const payload = await read(
        `/internal/flags/${encodeURIComponent(flagId)}/stats`,
        {
          ...(query.environmentId === undefined
            ? {}
            : { environmentId: query.environmentId }),
          days: String(query.days),
          granularity: query.granularity,
          tz: query.tz,
        },
      );
      return parsedOrThrow(flagStatsResponseSchema, payload, "stats của flag");
    },
    async staleFlags(query) {
      const payload = await read("/internal/stale-flags", {
        projectId: query.projectId,
        ...(query.category === undefined ? {} : { category: query.category }),
        limit: String(query.limit),
        offset: String(query.offset),
      });
      return parsedOrThrow(
        staleFlagsResponseSchema,
        payload,
        "danh sách flag chết",
      );
    },
    async flagStatsSummary(query) {
      const payload = await read("/internal/flag-stats/summary", {
        environmentId: query.environmentId,
        flagIds: query.flagIds.join(","),
        tz: query.tz,
      });
      return parsedOrThrow(
        flagStatsSummarySchema,
        payload,
        "tổng hợp stats của danh sách flag",
      );
    },
    async createSegment(body, ctx) {
      const payload = await call("POST", "/internal/segments", body, ctx);
      return parsedOrThrow(createdSegmentSchema, payload, "segment vừa tạo")
        .segment.id;
    },
    async updateSegment(segmentId, projectId, body, ctx) {
      await call("PUT", segmentPath(segmentId, projectId), body, ctx);
    },
    async deleteSegment(segmentId, projectId, ctx) {
      await call("DELETE", segmentPath(segmentId, projectId), undefined, ctx);
    },
    /**
     * Tạo khoá — thử lại ĐÚNG MỘT lần khi hết giờ hoặc 503, với CÙNG vật liệu
     * (V4, R24).
     *
     * Đây là lần thử lại duy nhất trong cả client, và nó chỉ đúng vì route đích
     * idempotent theo `key_hash`: `key_hash` là `@unique`, và Service 2 tra nó
     * TRƯỚC khi đếm quota, nên lần thử thứ hai cho một khoá đã commit trả 200
     * `created:false` thay vì 422 `QUOTA_EXCEEDED` (C-05). Gửi lại cùng vật liệu
     * là điều kiện của cả hai tính chất ấy.
     *
     * Hình dạng nó chữa (R24): Service 2 commit xong nhưng response chậm hơn
     * `configWriteTimeoutMs`, hoặc thân không đọc được. Không có lần thử lại thì
     * người dùng nhận 503 và không bao giờ thấy plaintext, trong khi khoá đã hợp
     * lệ trong database — một khoá mồ côi họ không biết để thu hồi.
     *
     * CHỈ `ServiceUnavailableError`, tức mạng, hết giờ, 5xx và thân 2xx không đọc
     * được. Lỗi nghiệp vụ (409, 422) thử lại vẫn ra đúng câu trả lời đó, nên thử
     * lại là hai lượt đi về cho cùng một kết quả.
     */
    async createSdkKey(body, ctx) {
      const payload = await retryOnceIfUnavailable(() =>
        call("POST", "/internal/sdk-keys", body, ctx),
      );
      return parsedOrThrow(createdSdkKeySchema, payload, "SDK key vừa tạo").key
        .id;
    },
    async revokeSdkKey(keyId, environmentId, ctx) {
      const search = new URLSearchParams({ environmentId }).toString();
      await call(
        "DELETE",
        `/internal/sdk-keys/${encodeURIComponent(keyId)}?${search}`,
        undefined,
        ctx,
      );
    },
    async backfillEnvironment(environmentId, ctx) {
      const payload = await call(
        "POST",
        `/internal/environments/${encodeURIComponent(environmentId)}/backfill`,
        {},
        ctx,
      );
      return parsedOrThrow(backfillSchema, payload, "kết quả backfill").created;
    },
  };

  /** Đường ghi một segment có sẵn — `projectId` là phép kiểm sở hữu của S2 (R05) */
  function segmentPath(segmentId: string, projectId: string): string {
    const search = new URLSearchParams({ projectId }).toString();
    return `/internal/segments/${encodeURIComponent(segmentId)}?${search}`;
  }

  /** GET nội bộ: không thân, không ngữ cảnh audit (chỉ đọc), hạn chờ của đường đọc */
  function read(path: string, query: Record<string, string>): Promise<unknown> {
    const search = new URLSearchParams(query).toString();
    return call("GET", `${path}?${search}`, undefined, {}, "read");
  }
}

/**
 * Parse response của S2 bằng CHÍNH schema dùng chung, không ép kiểu.
 *
 * S1 trả các hình này thẳng tới Portal (chỉ gắn thêm tên environment), nên một
 * lệch hợp đồng phải nổ ở biên chứ không trôi tới người dùng — cùng lý lẽ đã dựng
 * cho `testerResultSchema` ở [v4.6].
 */
/**
 * Chạy lại `attempt` ĐÚNG MỘT lần nếu lần đầu ra 503 (V4).
 *
 * Một lần, không vòng lặp có trần: lần thử lại ở đây tồn tại để không mất
 * plaintext của một khoá CÓ THỂ đã commit, không để chống một sự cố kéo dài. Nếu
 * Service 2 thật sự đang chết thì lần thứ hai cũng 503, và câu trả lời đúng cho
 * người dùng là 503 chứ không phải chờ thêm ba lượt nữa trong khi giữ một token
 * chưa ai lưu.
 */
async function retryOnceIfUnavailable(
  attempt: () => Promise<unknown>,
): Promise<unknown> {
  try {
    return await attempt();
  } catch (err: unknown) {
    if (!(err instanceof ServiceUnavailableError)) throw err;
    return attempt();
  }
}

function parsedOrThrow<T>(
  schema: z.ZodType<T>,
  payload: unknown,
  what: string,
): T {
  const parsed = schema.safeParse(payload);
  if (!parsed.success) {
    logger.error(
      { issues: parsed.error.issues },
      `Service 2 trả ${what} sai hình — hai service lệch hợp đồng`,
    );
    throw new Error(`Response ${what} của Service 2 sai hình`);
  }
  return parsed.data;
}
