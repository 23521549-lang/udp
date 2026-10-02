import { env } from "@udp/config";
import { CICD_WEBHOOK } from "@udp/config/constants";
import {
  TRUSTED_DEPLOY_RETRYABLE,
  type TrustedDeployRejection,
} from "@udp/shared-types";
import {
  createLocalJWKSet,
  decodeProtectedHeader,
  jwtVerify,
  type JSONWebKeySet,
  type JWTPayload,
} from "jose";
import { z } from "zod";
import { API_PREFIX } from "../../core/http/api-prefix.js";
import { circleciConfigSchema } from "../cicd-adapter/circleci/index.js";
import { githubActionsConfigSchema } from "../cicd-adapter/github-actions/index.js";
import { gitlabCiConfigSchema } from "../cicd-adapter/gitlab-ci/index.js";

/**
 * [Plan #61 QĐ-17, 61d-2a] Trusted Deploy (AC-11) — lời báo của pipeline mang một token OIDC của CHÍNH
 * lượt chạy đó, và UDP xác minh nó.
 *
 * Hai lớp độc lập trên cùng một webhook, và không lớp nào thay được lớp kia: HMAC chứng minh **thân**
 * không bị sửa, Trusted Deploy chứng minh **lượt chạy** là thật. Secret HMAC rất hay được đặt làm
 * org-level secret của GitHub nên một repo khác trong cùng tổ chức đọc được nó; lúc đó claim của token là
 * cổng cuối cùng.
 *
 * Ba luật khai sinh của tệp này, mỗi luật chặn một đường tấn công cụ thể:
 *
 *  1. **Issuer suy từ CẤU HÌNH, không bao giờ từ `iss` của token.** Lấy discovery document theo `iss` của
 *     một token chưa xác minh là bypass toàn phần, không chỉ SSRF: kẻ có secret HMAC dựng issuer của
 *     mình, trả JWKS của mình, ký một token với mọi claim nó muốn — và chữ ký sẽ ĐÚNG.
 *  2. **Mọi lời gọi mạng đi qua `egressFetch` tiêm vào.** `gitlabUrl` là cấu hình MAINTAINER lưu được, và
 *     regex của nó nhận cả `https://169.254.169.254`. Luật của repo (`cluster-access/src/transport.ts`)
 *     là Service 1 gọi URL do người dùng nhập thì phải đi `createEgressFetch`, có chặn SSRF ngay trong
 *     `lookup` để không hở DNS rebinding. Vì vậy ở đây KHÔNG dùng `createRemoteJWKSet` của jose (nó đi
 *     `fetch` toàn cục): tự lấy JWKS qua `egressFetch` rồi `createLocalJWKSet`. Đổi lại còn được hai thứ:
 *     giữ được bản khoá cũ khi nhà cung cấp hỏng, và một đường kiểm tất định cho test.
 *  3. **`aud` dựng chỉ từ phía máy chủ.** Bên gọi đặt được header `Host` (`TRUST_PROXY_HOPS` mặc định 0),
 *     nên dựng `aud` mong đợi từ request là biến phép kiểm thành "chuỗi của kẻ tấn công bằng chính nó".
 *
 * Việc xác minh chạy **sau** khi HMAC đúng và **ngoài** transaction của webhook. Sau HMAC vì §8.3 quy
 * định bốn tình huống trước đó là CÙNG một 401 để webhook không thành oracle dò project. Ngoài
 * transaction vì transaction đó giữ một advisory lock và một dòng project đã khoá; giữ chúng xuyên qua
 * một lời gọi HTTP ra ngoài là cách làm đứng cả control plane khi nhà cung cấp chậm.
 */

/** Vì sao một project chưa dùng được Trusted Deploy — Portal nói lại nguyên văn lý do này */
export type TrustedDeployUnavailable =
  "NO_PROVIDER" | "IN_CLUSTER_CI" | "MISSING_CIRCLECI_IDS";

/** Ba CI chạy TRONG CỤM: token của chúng là token ServiceAccount, chờ 61d-2b (§16) */
const IN_CLUSTER_PROVIDERS = new Set(["jenkins", "tekton", "drone"]);

/** Nơi lấy khoá công khai: `direct` là đường JWKS đã biết, `discover` phải đọc discovery document trước */
type KeySource =
  { kind: "direct"; jwksUri: string } | { kind: "discover"; issuer: string };

/** Claim mà token phải khớp, suy TỪ CẤU HÌNH của project */
export interface TrustedDeployExpectation {
  provider: string;
  issuer: string;
  keys: KeySource;
  audience: string;
  /** Claim mang định danh repo/project — tên claim khác nhau theo nhà cung cấp */
  repoClaim: { name: string; value: string };
  /** Claim mang git ref; `null` khi nhà cung cấp không phát nó */
  refClaim: string | null;
  /** Claim dùng làm mã một lần. CircleCI không phát `jti` nên dùng job-id của nó */
  tokenIdClaim: string;
}

export type TrustedDeployVerdict =
  | {
      kind: "verified";
      issuer: string;
      tokenId: string;
      /** `exp` của chính token — `webhook_token_uses.expires_at` lấy đúng giá trị này */
      expiresAt: Date;
      /** Git ref LẤY TỪ CLAIM, không từ thân webhook; `null` khi nhà cung cấp không phát */
      ref: string | null;
    }
  | { kind: "rejected"; code: TrustedDeployRejection; detail: string }
  /** Không có header `Authorization` — hợp lệ chỉ khi `oidcRequired` còn tắt */
  | { kind: "absent" };

const rejected = (
  code: TrustedDeployRejection,
  detail: string,
): TrustedDeployVerdict => ({ kind: "rejected", code, detail });

/** Lý do thuộc hạ tầng ⇒ 503 để bước báo của CI tự thử lại; mọi lý do khác là terminal ⇒ 401 */
export const isRetryableRejection = (code: TrustedDeployRejection): boolean =>
  TRUSTED_DEPLOY_RETRYABLE.includes(code);

// ----------------------------------------------------------------- mong đợi, suy từ cấu hình

/** Bỏ mọi dấu `/` cuối: `CORS_ORIGIN` khai bằng `z.string().url()` nên `https://host/` là hợp lệ */
export const normalizeOrigin = (origin: string): string =>
  origin.replace(/\/+$/, "");

/**
 * Địa chỉ webhook TUYỆT ĐỐI — nguồn sự thật duy nhất cho `aud` (R8).
 *
 * `projectId` hạ về chữ thường: regex UUID của webhook là case-insensitive và Postgres chuẩn hoá kiểu
 * `uuid`, nên một URL viết hoa vẫn tra ra đúng project mà sinh một chuỗi `aud` KHÁC.
 */
export const webhookUrlOf = (args: { origin: string; path: string }): string =>
  `${normalizeOrigin(args.origin)}${args.path}`;

/** Đường webhook của một project — một bản duy nhất, dùng bởi cả phía quản trị và phía nhận lời báo (R8) */
export const webhookPathOf = (projectId: string, provider: string): string =>
  `${API_PREFIX}/webhooks/cicd/${projectId.toLowerCase()}/${provider}`;

/**
 * Địa chỉ webhook tuyệt đối — chuỗi mà `aud` của token phải BẰNG, và chuỗi mà Portal in ra.
 *
 * Dựng CHỈ từ cấu hình máy chủ, không bao giờ từ request: `TRUST_PROXY_HOPS` mặc định 0 nên `req.hostname`
 * LÀ header `Host` do bên gọi đặt, và dựng `aud` mong đợi từ đó biến phép kiểm thành "chuỗi của kẻ tấn
 * công bằng chính nó". Dùng `CORS_ORIGIN` chứ không thêm một biến thứ hai cho cùng việc (R8): nó LÀ origin
 * của Portal, tức đúng chuỗi người dùng vẫn copy, và đã có tiền lệ ghép URL công khai từ nó.
 */
export const absoluteWebhookUrlOf = (
  projectId: string,
  provider: string,
): string =>
  webhookUrlOf({
    origin: env.CORS_ORIGIN,
    path: webhookPathOf(projectId, provider),
  });

/**
 * Suy mong đợi từ `(selectedTool, toolConfig)`. Trả một lý do khi UDP chưa kiểm được token của provider
 * đó — và khi đó KHÔNG được cho bật chế độ bắt buộc, vì bật một cổng mà UDP không kiểm nổi là tự khoá
 * project ra ngoài.
 */
export function expectationOf(args: {
  provider: string | null;
  toolConfig: unknown;
  audience: string;
}): TrustedDeployExpectation | { unavailable: TrustedDeployUnavailable } {
  const { provider, toolConfig, audience } = args;
  if (provider === null) return { unavailable: "NO_PROVIDER" };
  if (IN_CLUSTER_PROVIDERS.has(provider))
    return { unavailable: "IN_CLUSTER_CI" };

  if (provider === "github-actions") {
    const cfg = githubActionsConfigSchema.parse(toolConfig);
    return {
      provider,
      issuer: "https://token.actions.githubusercontent.com",
      // Đường JWKS đã đọc tại discovery document của GitHub (02/10/2026) nên ghim thẳng: không một lời
      // gọi discovery nào, tức một bề mặt mạng ít hơn.
      keys: {
        kind: "direct",
        jwksUri: "https://token.actions.githubusercontent.com/.well-known/jwks",
      },
      audience,
      repoClaim: { name: "repository", value: cfg.repository },
      refClaim: "ref",
      tokenIdClaim: "jti",
    };
  }

  if (provider === "gitlab-ci") {
    const cfg = gitlabCiConfigSchema.parse(toolConfig);
    const base = normalizeOrigin(cfg.gitlabUrl);
    return {
      provider,
      issuer: base,
      keys: { kind: "direct", jwksUri: `${base}/oauth/discovery/keys` },
      audience,
      repoClaim: { name: "project_path", value: cfg.projectPath },
      refClaim: "ref",
      tokenIdClaim: "jti",
    };
  }

  if (provider === "circleci") {
    const cfg = circleciConfigSchema.parse(toolConfig);
    // Fail-closed: `iss` của CircleCI là `.../org/<orgId>`, nên thiếu `organizationId` là KHÔNG CÓ issuer
    // mong đợi. Lấy issuer từ token để lấp chỗ trống chính là đường bypass mà luật 1 cấm.
    if (cfg.organizationId === undefined || cfg.projectId === undefined) {
      return { unavailable: "MISSING_CIRCLECI_IDS" };
    }
    const issuer = `https://oidc.circleci.com/org/${cfg.organizationId}`;
    return {
      provider,
      issuer,
      // Tài liệu của CircleCI không công bố đường JWKS, nên phải đi discovery — nhưng CHỈ trên issuer
      // mong đợi, và `jwks_uri` trả về phải cùng origin với nó.
      keys: { kind: "discover", issuer },
      audience,
      repoClaim: {
        name: "oidc.circleci.com/project-id",
        value: cfg.projectId,
      },
      refClaim: "oidc.circleci.com/vcs-ref",
      tokenIdClaim: "oidc.circleci.com/job-id",
    };
  }

  return { unavailable: "NO_PROVIDER" };
}

// ----------------------------------------------------------------- khoá công khai

const jwksSchema = z.object({
  keys: z.array(z.record(z.string(), z.unknown())).min(1),
});
const discoverySchema = z.object({ jwks_uri: z.string().url() });

interface CachedKeys {
  jwks: JSONWebKeySet;
  fetchedAt: number;
  /** Lần cuối ĐÃ THỬ lấy mới — nền của cooldown, kể cả khi lần thử đó hỏng */
  attemptedAt: number;
}

/**
 * Cache theo issuer ĐÃ ĐƯỢC CẤU HÌNH XÁC NHẬN (không bao giờ theo `iss` của token).
 *
 * Ba tính chất, mỗi cái chặn một chế độ hỏng thật:
 *  - `cacheMs`: không gọi ra ngoài trên mỗi webhook.
 *  - `staleMs`: nhà cung cấp hỏng thì vẫn phục vụ bản khoá cũ. Không có nó, một sự cố của GitHub cộng một
 *    lượt restart của S1 là mọi project không deploy được gì, kể cả bản vá cho chính sự cố đó.
 *  - `cooldownMs`: `kid` lạ mới được lấy mới, và chỉ sau cooldown. Không có nó, một kẻ có secret HMAC gửi
 *    `kid` ngẫu nhiên liên tục biến UDP thành bộ khuếch đại DoS vào nhà cung cấp và tự cạn socket.
 */
const KEY_CACHE = {
  cacheMs: 15 * 60_000,
  staleMs: 24 * 60 * 60_000,
  cooldownMs: 30_000,
} as const;

const cache = new Map<string, CachedKeys>();
const inFlight = new Map<string, Promise<CachedKeys>>();

/** Chỉ để test: cache là trạng thái mức module, nên mỗi tệp test phải bắt đầu từ một tờ giấy trắng */
export function resetTrustedDeployKeyCache(): void {
  cache.clear();
  inFlight.clear();
}

class KeysUnavailable extends Error {}

async function readJson(
  egressFetch: typeof fetch,
  url: string,
): Promise<unknown> {
  const res = await egressFetch(url, {
    method: "GET",
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(CICD_WEBHOOK.tokenVerifyTimeoutMs),
  });
  if (!res.ok) throw new KeysUnavailable(`${url} trả ${String(res.status)}`);
  return await res.json();
}

async function fetchKeys(
  egressFetch: typeof fetch,
  keys: KeySource,
): Promise<JSONWebKeySet> {
  if (keys.kind === "direct") {
    return jwksSchema.parse(await readJson(egressFetch, keys.jwksUri));
  }
  const doc = discoverySchema.parse(
    await readJson(
      egressFetch,
      `${keys.issuer}/.well-known/openid-configuration`,
    ),
  );
  // `jwks_uri` phải CÙNG ORIGIN với issuer mong đợi: một discovery document thù địch (hay bị chiếm) không
  // được dùng làm bàn đạp để UDP đi lấy khoá ở nơi khác.
  if (new URL(doc.jwks_uri).origin !== new URL(keys.issuer).origin) {
    throw new KeysUnavailable(
      `jwks_uri của ${keys.issuer} trỏ sang origin khác`,
    );
  }
  return jwksSchema.parse(await readJson(egressFetch, doc.jwks_uri));
}

async function keysFor(args: {
  expected: TrustedDeployExpectation;
  egressFetch: typeof fetch;
  now: number;
  /** `true` khi `kid` của token không có trong bản cache — chỉ lúc đó mới đáng lấy mới sớm */
  refresh: boolean;
}): Promise<JSONWebKeySet> {
  const { expected, egressFetch, now, refresh } = args;
  const key = expected.issuer;
  const held = cache.get(key);
  const fresh = held !== undefined && now - held.fetchedAt < KEY_CACHE.cacheMs;
  const cooling =
    held !== undefined && now - held.attemptedAt < KEY_CACHE.cooldownMs;
  if (held !== undefined && ((fresh && !refresh) || (refresh && cooling))) {
    return held.jwks;
  }

  const running = inFlight.get(key);
  if (running !== undefined) return (await running).jwks;

  const task = (async (): Promise<CachedKeys> => {
    try {
      const jwks = await fetchKeys(egressFetch, expected.keys);
      return { jwks, fetchedAt: now, attemptedAt: now };
    } catch (err) {
      // Giữ bản cũ còn trong hạn `staleMs`: trạng thái xấu nhất phải là CŨ, không bao giờ là "rơi về
      // HMAC" — rơi về HMAC chính là thoái cấp mà chế độ bắt buộc sinh ra để chặn.
      if (held !== undefined && now - held.fetchedAt < KEY_CACHE.staleMs) {
        return { ...held, attemptedAt: now };
      }
      throw err instanceof KeysUnavailable
        ? err
        : new KeysUnavailable(String(err));
    }
  })();
  inFlight.set(key, task);
  try {
    const got = await task;
    cache.set(key, got);
    return got.jwks;
  } finally {
    inFlight.delete(key);
  }
}

// ----------------------------------------------------------------- xác minh

const BEARER = /^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/;
/** Trần tường minh, không dựa vào `maxHeaderSize` của Node */
const MAX_TOKEN_CHARS = 8192;
/** Mã một lần đi vào một unique index: giới hạn hình dạng để không có gì lạ lọt vào đó */
const TOKEN_ID = /^[\x21-\x7e]{1,255}$/;

const claimString = (payload: JWTPayload, name: string): string | null => {
  const v = payload[name];
  return typeof v === "string" && v.length > 0 ? v : null;
};

/**
 * Xác minh header `Authorization` của một lời báo webhook.
 *
 * Gọi sau `verified()` (HMAC) và ngoài transaction. Không bao giờ ghi token vào log hay audit: I24 và
 * luật "không ghi thân hay header" của §8.3.
 */
export async function verifyTrustedDeploy(args: {
  expected: TrustedDeployExpectation;
  authorization: string | undefined;
  egressFetch: typeof fetch;
  now: Date;
}): Promise<TrustedDeployVerdict> {
  const { expected, authorization, egressFetch, now } = args;
  if (authorization === undefined || authorization.length === 0) {
    return { kind: "absent" };
  }
  if (authorization.length > MAX_TOKEN_CHARS) {
    return rejected("TOKEN_MALFORMED", "header quá dài");
  }
  const matched = BEARER.exec(authorization);
  if (matched === null) {
    return rejected("TOKEN_MALFORMED", "không phải một Bearer JWT ba phần");
  }
  const token = matched[1] ?? "";

  // `iss` đọc TRƯỚC khi gọi mạng, và chỉ để SO với issuer mong đợi — không bao giờ để quyết đi lấy khoá ở
  // đâu. Phần header/payload chưa được xác minh nên mọi giá trị ở đây là dữ liệu, không phải thẩm quyền.
  let unverified: JWTPayload;
  let kid: string | undefined;
  try {
    kid = decodeProtectedHeader(token).kid;
    unverified = JSON.parse(
      Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8"),
    ) as JWTPayload;
  } catch {
    return rejected("TOKEN_MALFORMED", "không giải được header hay payload");
  }
  if (unverified.iss !== expected.issuer) {
    return rejected(
      "TOKEN_ISSUER_UNEXPECTED",
      `iss không phải issuer của ${expected.provider} trong cấu hình project`,
    );
  }

  const known = cache.get(expected.issuer);
  const kidMissing =
    kid !== undefined &&
    known !== undefined &&
    !known.jwks.keys.some((k) => k.kid === kid);

  let jwks: JSONWebKeySet;
  try {
    jwks = await keysFor({
      expected,
      egressFetch,
      now: now.getTime(),
      refresh: kidMissing,
    });
  } catch (err) {
    return rejected(
      "TOKEN_KEYS_UNAVAILABLE",
      err instanceof Error ? err.message : "không lấy được khoá công khai",
    );
  }

  let payload: JWTPayload;
  try {
    const result = await jwtVerify(token, createLocalJWKSet(jwks), {
      issuer: expected.issuer,
      audience: expected.audience,
      // Ba nhà cung cấp đều RS256 (đã đọc tại discovery document). Ghim lại đóng cả lớp alg-confusion.
      algorithms: ["RS256"],
      // Đo được: với `maxTokenAge`, jose ĐÒI `iat`, và nó kiểm `exp` độc lập. Trần này là trần CHÍNH
      // SÁCH của UDP, chỉ làm NGẮN hơn `exp`, không bao giờ dài hơn.
      maxTokenAge: CICD_WEBHOOK.tokenMaxAgeSeconds,
      clockTolerance: CICD_WEBHOOK.tokenClockToleranceSeconds,
      currentDate: now,
    });
    payload = result.payload;
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (
      code === "ERR_JWT_EXPIRED" ||
      code === "ERR_JWT_CLAIM_VALIDATION_FAILED"
    ) {
      // `aud` sai và `exp` quá hạn cùng ra `ERR_JWT_CLAIM_VALIDATION_FAILED`, nên tách bằng chính thông
      // điệp của jose thay vì đoán.
      const message = err instanceof Error ? err.message : "";
      if (code === "ERR_JWT_EXPIRED" || /"iat"|"exp"|"nbf"/.test(message)) {
        return rejected("TOKEN_EXPIRED", message);
      }
      return rejected("TOKEN_AUDIENCE_MISMATCH", message);
    }
    return rejected(
      "TOKEN_INVALID",
      err instanceof Error ? err.message : "chữ ký không hợp lệ",
    );
  }

  const repo = claimString(payload, expected.repoClaim.name);
  if (repo !== expected.repoClaim.value) {
    return rejected(
      "TOKEN_CLAIM_MISMATCH",
      `${expected.repoClaim.name} của token không khớp cấu hình project`,
    );
  }

  const tokenId = claimString(payload, expected.tokenIdClaim);
  if (tokenId === null || !TOKEN_ID.test(tokenId)) {
    // Fail closed: không có mã một lần thì không có cách nào cưỡng chế "dùng một lần" (I41), và bỏ qua
    // trong im lặng là mất đúng tính chất mà AC-11 tuyên bố.
    return rejected(
      "TOKEN_CLAIM_MISMATCH",
      `token không mang ${expected.tokenIdClaim} dùng được làm mã một lần`,
    );
  }

  const exp = payload.exp;
  if (typeof exp !== "number") {
    return rejected("TOKEN_EXPIRED", "token không mang exp");
  }

  return {
    kind: "verified",
    issuer: expected.issuer,
    tokenId,
    expiresAt: new Date(exp * 1000),
    ref:
      expected.refClaim === null
        ? null
        : claimString(payload, expected.refClaim),
  };
}
