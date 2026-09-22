import {
  ACTOR_HEADER,
  CLIENT_IP_HEADER,
  CLIENT_UA_HEADER,
  INTERNAL_CALL,
  INTERNAL_SECRET_HEADER,
  ROLLOUT_CREATE,
} from "@udp/config";
import {
  logger,
  relayedProblemOf,
  ServiceUnavailableError,
  type AuditContext,
} from "@udp/http";
import {
  trackOutcomeOf,
  type CreateFlagFields,
  type ReplaceRulesFields,
  testerResultSchema,
  type TesterResult,
  type TrackOutcome,
  type UpdateEnvConfigFields,
  type UpdateFlagFields,
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
  /** [v4.6] Flag Evaluation Tester — chỉ đọc, không ngữ cảnh audit */
  evaluateFlag(
    flagId: string,
    body: { environmentId: string; context: Record<string, unknown> },
  ): Promise<TesterResult>;
}

const createdFlagSchema = z.object({
  flag: z.object({ id: z.string().uuid() }),
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
   * Một lời gọi tới Service 2 (bốn lời gọi ghi cấu hình, và Tester). 2xx ⇒ body. Lỗi nghiệp vụ (404/409/422) ⇒
   * `RelayedProblemError` — Portal nhận đúng mã, `current`, `resourceId` của S2.
   * 5xx/mạng/hết giờ ⇒ 503 (thử lại có ích). Mọi status khác (400/401/403) là
   * hai service lệch hợp đồng hay cấu hình — không phải lỗi của người dùng: log
   * error, 500, KHÔNG chuyển 401 tới Portal (nó sẽ đăng xuất người dùng).
   */
  async function call(
    method: "POST" | "PATCH" | "PUT",
    path: string,
    body: object,
    ctx: AuditContext,
    purpose: "write" | "read" = "write",
  ): Promise<unknown> {
    let res: Response;
    try {
      res = await fetchImpl(`${baseUrl}${path}`, {
        method,
        headers: {
          "content-type": "application/json",
          [INTERNAL_SECRET_HEADER]: options.secret,
          ...(ctx.actorUserId === undefined
            ? {}
            : { [ACTOR_HEADER]: ctx.actorUserId }),
          ...(ctx.ip === undefined ? {} : { [CLIENT_IP_HEADER]: ctx.ip }),
          ...(ctx.userAgent === undefined
            ? {}
            : { [CLIENT_UA_HEADER]: ctx.userAgent }),
        },
        body: JSON.stringify(body),
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
    async evaluateFlag(flagId, body) {
      const payload = await call(
        "POST",
        `/internal/flags/${encodeURIComponent(flagId)}/evaluate`,
        body,
        {},
        "read",
      );
      const parsed = testerResultSchema.safeParse(payload);
      if (!parsed.success) {
        logger.error(
          { issues: parsed.error.issues },
          "Service 2 trả kết quả Tester sai hình — hai service lệch hợp đồng",
        );
        throw new Error("Response Tester của Service 2 sai hình");
      }
      return parsed.data;
    },
  };
}
