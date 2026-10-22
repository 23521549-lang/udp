import { createHash } from "node:crypto";
import type { InClusterApi } from "./api.js";

/**
 * [Plan #67] Hỏi API server của cụm UDP xem ai đứng sau một token chiếu của ServiceAccount (`TokenReview`,
 * `authentication.k8s.io/v1`) - lớp danh tính của T12 cho `/internal/*` của Service 1 và Service 2.
 *
 * Trả username khi ĐỦ ba điều, `null` khi thiếu bất kỳ điều nào:
 *  1. `status.authenticated`;
 *  2. `status.audiences` chứa đúng audience của bên nhận - tài liệu Kubernetes: bên đặt `spec.audiences` phải kiểm điều
 *     này, nếu không thì không chắc API server hiểu audience (một authenticator không biết audience trả rỗng);
 *  3. `status.user.username` là chuỗi. Username có thuộc danh sách bên gọi hay không là việc của middleware.
 *
 * `TokenReview` chứ không kiểm chữ ký bằng JWKS (lối của Trusted Deploy, §8.3): token chiếu gắn với đối tượng pod, và
 * chỉ API server biết pod đó còn sống.
 *
 * Nhớ: dương `ttlMs` theo sha256 của token (không giữ token), gộp các lời hỏi cùng token đang bay; âm KHÔNG nhớ. API
 * server không trả lời (lỗi mạng, 429, 5xx) ⇒ dùng tiếp kết quả dương ĐÃ CÓ của đúng token đó tới `staleMs` kể từ lần
 * xác nhận cuối - một lần k3s khởi động lại ngắn không làm sập mọi đường nội bộ - còn không thì NÉM (bên dùng trả 503).
 * Câu trả lời "không" của API server luôn thắng bản nhớ, và xoá nó. 401/403 từ API server là cấu hình sai (thiếu
 * `tokenreviews: create`), không phải vắng mặt: ném, không dùng bản nhớ.
 *
 * Không thông điệp lỗi nào chứa token.
 */

export interface TokenReviewOptions {
  api: Pick<InClusterApi, "apiServer" | "transport" | "token">;
  /** Audience của CHÍNH bên nhận - `INTERNAL_AUDIENCE` của `@udp/config/constants` */
  audience: string;
  ttlMs?: number;
  staleMs?: number;
  maxEntries?: number;
  now?: () => number;
}

/** Cùng hình với `CallerVerifier` của `@udp/http` - gói này không import `@udp/http` (kéo theo database và env) */
export interface TokenReviewVerifier {
  verify(token: string): Promise<string | null>;
}

export const TOKEN_REVIEW_PATH = "/apis/authentication.k8s.io/v1/tokenreviews";

class Unavailable extends Error {}

interface Entry {
  username: string;
  confirmedAt: number;
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

export function tokenReviewVerifier(
  options: TokenReviewOptions,
): TokenReviewVerifier {
  const ttlMs = options.ttlMs ?? 10_000;
  const staleMs = options.staleMs ?? 60_000;
  const maxEntries = options.maxEntries ?? 256;
  const now = options.now ?? Date.now;
  const cache = new Map<string, Entry>();
  const inFlight = new Map<string, Promise<string | null>>();

  const remember = (key: string, username: string): void => {
    cache.delete(key);
    if (cache.size >= maxEntries) {
      const oldest = cache.keys().next();
      if (oldest.done !== true) cache.delete(oldest.value);
    }
    cache.set(key, { username, confirmedAt: now() });
  };

  /** `null`: API server nói "không"; ném `Unavailable`: không hỏi được; ném lỗi khác: cấu hình sai */
  const review = async (token: string): Promise<string | null> => {
    let res: Response;
    try {
      res = await options.api.transport.request(
        `${options.api.apiServer}${TOKEN_REVIEW_PATH}`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${await options.api.token()}`,
            "Content-Type": "application/json",
            Accept: "application/json",
          },
          body: JSON.stringify({
            apiVersion: "authentication.k8s.io/v1",
            kind: "TokenReview",
            spec: { token, audiences: [options.audience] },
          }),
        },
      );
    } catch (err) {
      throw new Unavailable(
        `TokenReview không tới được API server: ${err instanceof Error ? err.name : "lỗi"}`,
      );
    }
    if (res.status === 429 || res.status >= 500) {
      throw new Unavailable(
        `TokenReview: API server trả ${String(res.status)}`,
      );
    }
    if (!res.ok) {
      throw new Error(
        `TokenReview: API server trả ${String(res.status)} - ServiceAccount của service thiếu quyền tokenreviews: create?`,
      );
    }
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      throw new Unavailable("TokenReview: thân trả lời không phải JSON");
    }
    const status = isObject(body) ? body["status"] : undefined;
    if (!isObject(status) || status["authenticated"] !== true) return null;
    const audiences = status["audiences"];
    if (!Array.isArray(audiences) || !audiences.includes(options.audience)) {
      return null;
    }
    const user = status["user"];
    const username = isObject(user) ? user["username"] : undefined;
    return typeof username === "string" && username !== "" ? username : null;
  };

  const ask = async (key: string, token: string): Promise<string | null> => {
    try {
      const username = await review(token);
      if (username === null) cache.delete(key);
      else remember(key, username);
      return username;
    } catch (err) {
      const kept = cache.get(key);
      if (
        err instanceof Unavailable &&
        kept !== undefined &&
        now() - kept.confirmedAt < staleMs
      ) {
        return kept.username;
      }
      throw err;
    }
  };

  return {
    verify(token) {
      const key = createHash("sha256").update(token).digest("hex");
      const kept = cache.get(key);
      if (kept !== undefined && now() - kept.confirmedAt < ttlMs) {
        return Promise.resolve(kept.username);
      }
      const pending = inFlight.get(key);
      if (pending !== undefined) return pending;
      const asked = ask(key, token).finally(() => {
        inFlight.delete(key);
      });
      inFlight.set(key, asked);
      return asked;
    },
  };
}
