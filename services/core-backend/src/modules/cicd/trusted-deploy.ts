import { env } from "@udp/config";
import { CICD_WEBHOOK } from "@udp/config/constants";
import {
  IN_CLUSTER_CI,
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
import {
  BUILD_NAMESPACE,
  BUILDER_SERVICE_ACCOUNT,
} from "../adapter-base/packaging/build-script.js";

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

/**
 * Vì sao một project chưa dùng được Trusted Deploy — Portal nói lại nguyên văn lý do này.
 *
 * [61d-2b-1] `IN_CLUSTER_CI` đã CHẾT: ba CI chạy trong cụm giờ kiểm được. Thay nó là `CLUSTER_NOT_READY`
 * (project chưa có cụm provision xong thì chưa có khoá nào để kiểm). Tên không phải `NO_CLUSTER` vì
 * `IdentityScriptProblem` đã dùng đúng chuỗi đó với nghĩa khác, và hai union cùng hiện trên MỘT panel.
 */
export type TrustedDeployUnavailable =
  "NO_PROVIDER" | "CLUSTER_NOT_READY" | "MISSING_CIRCLECI_IDS";

/**
 * [Plan #61 QĐ-17, 61d-2a] Bảng nhà cung cấp OIDC — **khai báo**, không rải trong một hàm.
 *
 * Mọi giá trị ở đây đã được xác minh ngày 02/10/2026 tại tài liệu và tại chính OIDC discovery document của
 * nhà cung cấp, không lấy từ trí nhớ. Nó là bản chép thứ nhất; bản thứ hai là bảng trong §8.3 của
 * `UDP_design.md`, và `packages/design-lint/tests/trusted-deploy-providers.test.ts` khẳng định hai bên
 * bằng nhau. Lý do ghi sổ kép: một lỗi chính tả trong chuỗi issuer khi đó thành một test đỏ, chứ không
 * thành "từ chối mọi thứ" bí ẩn ở production — đúng khuôn `cluster-identity.test.ts` đã dùng cho §12.2.
 */
export const TRUSTED_DEPLOY_PROVIDERS = {
  "github-actions": {
    issuer: "https://token.actions.githubusercontent.com",
    /** Đường JWKS đã đọc tại discovery document, nên ghim thẳng: không một lời gọi discovery nào */
    jwksPath: "/.well-known/jwks",
    alg: "RS256",
    tokenIdClaim: "jti",
    repoClaim: "repository",
    refClaim: "ref",
    /** `aud` mong đợi là địa chỉ webhook tuyệt đối */
    audience: "webhook-url",
  },
  "gitlab-ci": {
    /** Issuer là `gitlabUrl` trong cấu hình project — GitLab tự host dùng domain của chính nó */
    issuer: "config:gitlabUrl",
    jwksPath: "/oauth/discovery/keys",
    alg: "RS256",
    tokenIdClaim: "jti",
    repoClaim: "project_path",
    refClaim: "ref",
    audience: "webhook-url",
  },
  circleci: {
    issuer: "https://oidc.circleci.com/org/{organizationId}",
    /** Tài liệu CircleCI KHÔNG công bố đường JWKS, nên phải đi discovery trên đúng issuer mong đợi */
    jwksPath: "discovery",
    alg: "RS256",
    /** CircleCI không phát `jti` (đã đọc tại tài liệu) — job-id là UUID của một job */
    tokenIdClaim: "oidc.circleci.com/job-id",
    repoClaim: "oidc.circleci.com/project-id",
    refClaim: "oidc.circleci.com/vcs-ref",
    /**
     * `aud` mặc định LÀ organizationId, và đổi nó cần một tính năng riêng ở mức tổ chức chứ không đặt
     * được trong `config.yml`. Cái giá phải công bố (§16): với CircleCI, `aud` không buộc token vào đúng
     * project này — mọi job trong cùng tổ chức đều có token mang đúng `aud` đó — nên việc buộc token vào
     * project đổi hoàn toàn sang claim `repoClaim` ở trên.
     */
    audience: "config:organizationId",
  },
} as const;

/**
 * [Plan #61 61d-2b-1] Bản khai của ba CI chạy TRONG CỤM — bản chép thứ nhất; bản thứ hai là đoạn
 * `[v4.12] 61d-2b-1` của §8.3, và `design-lint/tests/trusted-deploy-providers.test.ts` khẳng định hai bên
 * bằng nhau (cùng lý do ghi sổ kép như bảng nhà cung cấp SaaS).
 *
 * Khác bảng SaaS ở ba điểm, và cả ba là hệ quả của việc token do API server của chính cụm phát:
 *  - **Không có issuer trong bảng.** Chuỗi `iss` đọc từ discovery document của cụm lúc xác minh. Thứ buộc
 *    token vào project là KHOÁ của cụm đó, không phải một chuỗi ghim trong mã.
 *  - **Không có claim repo hay ref.** Token ServiceAccount không mang chúng (xem `cannotProve`).
 *  - **Thuật toán là một ALLOWLIST, không một giá trị.** Kubernetes suy
 *    `id_token_signing_alg_values_supported` TỪ KHOÁ đang hoạt động, nên một cụm dùng khoá EC khai `ES256`;
 *    ghim `RS256` như ba CI SaaS sẽ chặn cụm đó (đã đo bằng `jose`: `ERR_JOSE_ALG_NOT_ALLOWED`).
 */
/** Tiện cho hai chỗ đang import từ đây — nguồn duy nhất vẫn là `@udp/shared-types` */
export { IN_CLUSTER_CI };

export const IN_CLUSTER_TRUSTED_DEPLOY = {
  subject: `system:serviceaccount:${BUILD_NAMESPACE}:${BUILDER_SERVICE_ACCOUNT}`,
  audience: "webhook-url",
  tokenIdClaim: "jti",
  /** Điều lớp này KHÔNG chứng minh được, phải công bố ở §8.3, §16 và trên Portal */
  cannotProve: "nhánh",
  /** Giao với `id_token_signing_alg_values_supported` của cụm; giao rỗng ⇒ 503, không rơi về HMAC */
  algorithms: ["RS256", "ES256", "ES384", "ES512"],
} as const;

/** Nơi lấy khoá công khai: `direct` là đường JWKS đã biết, `discover` phải đọc discovery document trước */
type KeySource =
  { kind: "direct"; jwksUri: string } | { kind: "discover"; issuer: string };

/**
 * Khoá công khai của chính cụm của project, và chuỗi `issuer` mà cụm đó khai.
 *
 * `cacheKey` là `projectId`: mỗi project một cụm (tên cụm tất định theo `projectId`, và `projectCluster`
 * lấy cụm từ lượt PROVISION xong gần nhất CỦA CHÍNH project đó), nên nó là khoá cache đúng. `null` ở chỗ
 * nhận cổng này nghĩa là tiến trình không có đường ra cụm ⇒ 503 retryable, đúng tiền lệ `withCluster: null`.
 */
export interface ClusterKeyPort {
  cacheKey: string;
  read(): Promise<{
    issuer: string;
    algorithms: readonly string[];
    jwks: unknown;
  }>;
}

/** Claim mà token phải khớp, suy TỪ CẤU HÌNH của project */
export type TrustedDeployExpectation =
  | {
      kind: "provider";
      provider: string;
      issuer: string;
      keys: KeySource;
      audience: string;
      /** Thuật toán ghim cứng — ba CI SaaS đều RS256, đã đọc tại discovery document của họ */
      algorithms: readonly string[];
      /** Claim mang định danh repo/project — tên claim khác nhau theo nhà cung cấp */
      repoClaim: { name: string; value: string };
      /** Claim mang git ref; `null` khi nhà cung cấp không phát nó */
      refClaim: string | null;
      /** Claim dùng làm mã một lần. CircleCI không phát `jti` nên dùng job-id của nó */
      tokenIdClaim: string;
    }
  | {
      kind: "cluster";
      /** `jenkins` | `tekton` | `drone` */
      provider: string;
      audience: string;
      /**
       * Chủ thể BẮT BUỘC của token.
       *
       * Phép kiểm đáng tiền nhất của nhánh này: thiếu nó thì MỌI pod trong cụm — kể cả chính ứng dụng đang
       * được deploy — xin được token với `aud` của webhook rồi tự deploy image bất kỳ. Và `jose` KHÔNG kiểm
       * `sub` (đã đo), nên phép kiểm phải nằm ở mã của UDP.
       */
      subject: string;
      tokenIdClaim: string;
    };

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
  /** Địa chỉ webhook TUYỆT ĐỐI — là `aud` mong đợi với GitHub và GitLab */
  webhookUrl: string;
}): TrustedDeployExpectation | { unavailable: TrustedDeployUnavailable } {
  const { provider, toolConfig, webhookUrl } = args;
  if (provider === null) return { unavailable: "NO_PROVIDER" };
  if (IN_CLUSTER_CI.some((name) => name === provider)) {
    // [61d-2b-1] Issuer KHÔNG nằm ở đây: nó đọc từ discovery document của chính cụm lúc xác minh, và thứ
    // buộc token vào project là khoá của cụm đó. `clusterReady` do bên gọi tính (sổ tài nguyên) rồi truyền
    // vào `trustedDeployStateOf` — hàm này cố ý giữ tính thuần.
    return {
      kind: "cluster",
      provider,
      audience: webhookUrl,
      subject: IN_CLUSTER_TRUSTED_DEPLOY.subject,
      tokenIdClaim: IN_CLUSTER_TRUSTED_DEPLOY.tokenIdClaim,
    };
  }

  if (provider === "github-actions") {
    const cfg = githubActionsConfigSchema.parse(toolConfig);
    const spec = TRUSTED_DEPLOY_PROVIDERS["github-actions"];
    return {
      kind: "provider",
      provider,
      issuer: spec.issuer,
      // Đường JWKS lấy từ bảng khai báo ở trên (đã đọc tại discovery document của GitHub), nên ghim thẳng:
      // không một lời gọi discovery nào, tức một bề mặt mạng ít hơn.
      keys: { kind: "direct", jwksUri: `${spec.issuer}${spec.jwksPath}` },
      audience: webhookUrl,
      algorithms: [spec.alg],
      repoClaim: { name: spec.repoClaim, value: cfg.repository },
      refClaim: spec.refClaim,
      tokenIdClaim: spec.tokenIdClaim,
    };
  }

  if (provider === "gitlab-ci") {
    const cfg = gitlabCiConfigSchema.parse(toolConfig);
    const spec = TRUSTED_DEPLOY_PROVIDERS["gitlab-ci"];
    const base = normalizeOrigin(cfg.gitlabUrl);
    return {
      kind: "provider",
      provider,
      issuer: base,
      keys: { kind: "direct", jwksUri: `${base}${spec.jwksPath}` },
      audience: webhookUrl,
      algorithms: [spec.alg],
      repoClaim: { name: spec.repoClaim, value: cfg.projectPath },
      refClaim: spec.refClaim,
      tokenIdClaim: spec.tokenIdClaim,
    };
  }

  if (provider === "circleci") {
    const cfg = circleciConfigSchema.parse(toolConfig);
    const spec = TRUSTED_DEPLOY_PROVIDERS.circleci;
    // Fail-closed: `iss` của CircleCI là `.../org/<orgId>`, nên thiếu `organizationId` là KHÔNG CÓ issuer
    // mong đợi. Lấy issuer từ token để lấp chỗ trống chính là đường bypass toàn phần mà luật 1 cấm.
    if (cfg.organizationId === undefined || cfg.projectId === undefined) {
      return { unavailable: "MISSING_CIRCLECI_IDS" };
    }
    const issuer = spec.issuer.replace("{organizationId}", cfg.organizationId);
    return {
      kind: "provider",
      provider,
      issuer,
      // Tài liệu của CircleCI không công bố đường JWKS, nên phải đi discovery — nhưng CHỈ trên issuer
      // mong đợi, và `jwks_uri` trả về phải cùng origin với nó.
      keys: { kind: "discover", issuer },
      // `aud` mặc định LÀ organizationId: xem lý lẽ và cái giá ở bảng khai báo phía trên.
      audience: cfg.organizationId,
      algorithms: [spec.alg],
      repoClaim: { name: spec.repoClaim, value: cfg.projectId },
      refClaim: spec.refClaim,
      tokenIdClaim: spec.tokenIdClaim,
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
  /**
   * [61d-2b-1] Chuỗi `issuer` đi CÙNG bộ khoá này. Với ba CI SaaS nó là chuỗi suy từ cấu hình; với nhánh
   * cụm nó là chuỗi cụm khai trong discovery document của chính nó. Giữ cùng chỗ với khoá là có chủ đích:
   * hai giá trị đó phải đến từ CÙNG một lượt đọc, nếu không một lượt xoay issuer của cụm sẽ ghép khoá mới
   * với issuer cũ.
   */
  issuer: string;
  /** Thuật toán được phép cho CHÍNH bộ khoá này */
  algorithms: readonly string[];
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
  /**
   * [61d-2b-1] Nhánh cụm KHÔNG phục vụ khoá cũ.
   *
   * Lý lẽ `staleMs` là lý lẽ của SaaS: "GitHub sập thì vẫn phải deploy được bản vá". Nó không chuyển sang
   * đây, vì cụm không với tới được thì job deploy cũng **không áp được gì** — giữ khoá cũ 24 giờ không mua
   * được một chút tính khả dụng nào, chỉ mở một cửa sổ 24 giờ cho một khoá cụm đã xoay hay đã thu hồi.
   */
  clusterStaleMs: 0,
} as const;

const cache = new Map<string, CachedKeys>();
const inFlight = new Map<string, Promise<CachedKeys>>();
/**
 * [61d-2b-1] Cache ÂM: lần thử GẦN NHẤT đã hỏng, cho những khoá chưa từng lấy được.
 *
 * Vì sao cần: `cache` chỉ được ghi trên đường thành công, nên khi chưa có bản khoá nào, MỌI request hỏng
 * đều đi lấy lại ngay. Với nhánh cụm, mỗi lượt là một lần lấy credential cloud + một token quản trị + hai
 * lời gọi API server, nên một kẻ có secret HMAC của một project mà cụm đang hỏng biến webhook thành máy
 * bơm lời gọi vào cloud của khách. Ghi mốc thử ở đây làm `cooldownMs` có hiệu lực cho cả ca đó — và nó
 * lợi cho cả ba CI SaaS.
 */
const failedAt = new Map<string, number>();

/** Chỉ để test: cache là trạng thái mức module, nên mỗi tệp test phải bắt đầu từ một tờ giấy trắng */
export function resetTrustedDeployKeyCache(): void {
  cache.clear();
  inFlight.clear();
  failedAt.clear();
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

/**
 * Khoá công khai cho MỘT nguồn, có cache, có single-flight, có cooldown, có cache âm.
 *
 * `cacheKey` là thứ nhận diện nguồn: với ba CI SaaS là issuer **đã được cấu hình xác nhận** (không bao giờ
 * `iss` của token); với nhánh cụm là `projectId` (mỗi project một cụm). `load` là lượt đọc thật.
 */
async function keysFor(args: {
  cacheKey: string;
  staleMs: number;
  load: () => Promise<{
    jwks: JSONWebKeySet;
    issuer: string;
    algorithms: readonly string[];
  }>;
  now: number;
  /** `true` khi `kid` của token không có trong bản cache — chỉ lúc đó mới đáng lấy mới sớm */
  refresh: boolean;
}): Promise<CachedKeys> {
  const { cacheKey: key, staleMs, load, now, refresh } = args;
  const held = cache.get(key);
  const fresh = held !== undefined && now - held.fetchedAt < KEY_CACHE.cacheMs;
  const lastAttempt = held?.attemptedAt ?? failedAt.get(key);
  const cooling =
    lastAttempt !== undefined && now - lastAttempt < KEY_CACHE.cooldownMs;
  if (held !== undefined && ((fresh && !refresh) || (refresh && cooling))) {
    return held;
  }
  // Chưa từng lấy được VÀ lần thử gần nhất vừa hỏng ⇒ từ chối ngay, không gọi ra ngoài lần nữa
  if (held === undefined && cooling) {
    throw new KeysUnavailable(`${key}: lần thử trước vừa hỏng, đang cooldown`);
  }

  const running = inFlight.get(key);
  if (running !== undefined) return await running;

  const task = (async (): Promise<CachedKeys> => {
    try {
      const got = await load();
      return { ...got, fetchedAt: now, attemptedAt: now };
    } catch (err) {
      // Giữ bản cũ còn trong hạn `staleMs`: trạng thái xấu nhất phải là CŨ, không bao giờ là "rơi về
      // HMAC" — rơi về HMAC chính là thoái cấp mà chế độ bắt buộc sinh ra để chặn. Nhánh cụm truyền
      // `staleMs = 0` nên nó không bao giờ đi vào nhánh này.
      if (held !== undefined && now - held.fetchedAt < staleMs) {
        return { ...held, attemptedAt: now };
      }
      failedAt.set(key, now);
      throw err instanceof KeysUnavailable
        ? err
        : new KeysUnavailable(String(err));
    }
  })();
  inFlight.set(key, task);
  try {
    const got = await task;
    cache.set(key, got);
    failedAt.delete(key);
    return got;
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
  /**
   * [61d-2b-1] Đường đọc khoá của cụm — chỉ dùng cho `kind: "cluster"`. `null` nghĩa là tiến trình này
   * không có đường ra cụm (tiền lệ `withCluster: null` ⇒ 503), KHÔNG phải "bỏ qua phép kiểm".
   */
  clusterKeys: ClusterKeyPort | null;
  now: Date;
}): Promise<TrustedDeployVerdict> {
  const { expected, authorization, egressFetch, clusterKeys, now } = args;
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
  /**
   * Hai nhánh, hai THỨ TỰ, và sự khác biệt là có chủ đích.
   *
   * Ba CI SaaS: issuer mong đợi suy được từ cấu hình, nên so `iss` TRƯỚC mọi lời gọi mạng — một token của
   * issuer thù địch bị chặn với **không một lời gọi nào**.
   *
   * Nhánh cụm: issuer là thứ cụm khai, nên phải đọc cụm trước rồi mới so được. Điều đó KHÔNG mở lại đường
   * bypass, vì nơi đọc không phụ thuộc một chút nào vào token: nó luôn là cụm của chính project đang nhận
   * webhook. Cái giá là một lượt đọc (đã cache, có cooldown, có cache âm) cho một token sai `iss` — và lượt
   * đó chỉ xảy ra SAU khi HMAC đã đúng.
   */
  const source: {
    cacheKey: string;
    staleMs: number;
    load: () => Promise<{
      jwks: JSONWebKeySet;
      issuer: string;
      algorithms: readonly string[];
    }>;
  } =
    expected.kind === "provider"
      ? {
          cacheKey: expected.issuer,
          staleMs: KEY_CACHE.staleMs,
          load: async () => ({
            jwks: await fetchKeys(egressFetch, expected.keys),
            issuer: expected.issuer,
            algorithms: expected.algorithms,
          }),
        }
      : {
          cacheKey: `cluster:${clusterKeys?.cacheKey ?? ""}`,
          staleMs: KEY_CACHE.clusterStaleMs,
          load: async () => {
            // `clusterKeys === null` đã bị từ chối ở trên, trước khi chạm cache
            if (clusterKeys === null) {
              throw new KeysUnavailable("không có cổng đọc cụm");
            }
            const read = await clusterKeys.read();
            const jwks = jwksSchema.parse(read.jwks);
            // Giao với allowlist: Kubernetes suy danh sách alg TỪ KHOÁ nên không ghim cứng được, nhưng
            // cũng không nhận bừa — `HS*` hay `none` không bao giờ nằm trong allowlist này.
            const algorithms = read.algorithms.filter((alg) =>
              IN_CLUSTER_TRUSTED_DEPLOY.algorithms.some((ok) => ok === alg),
            );
            if (algorithms.length === 0) {
              throw new KeysUnavailable(
                "cụm không khai thuật toán nào UDP kiểm được",
              );
            }
            return { jwks, issuer: read.issuer, algorithms };
          },
        };

  /**
   * Không có cổng đọc cụm ⇒ từ chối NGAY, trước khi chạm cache.
   *
   * Bản đầu để `load()` ném với một khoá cache giả (`cluster:khong-co`): cùng kết quả 503, nhưng nó ghi một
   * mốc cache âm dùng CHUNG cho mọi project — một khoá cache mang ý nghĩa của tiến trình chứ không của dữ
   * liệu. Tiến trình không có đường ra cụm thì nó không có với MỌI project, nên câu trả lời không cần cache.
   */
  if (expected.kind === "cluster" && clusterKeys === null) {
    return rejected(
      "TOKEN_KEYS_UNAVAILABLE",
      "tiến trình này không có đường ra cụm của project",
    );
  }

  if (expected.kind === "provider" && unverified.iss !== expected.issuer) {
    return rejected(
      "TOKEN_ISSUER_UNEXPECTED",
      `iss không phải issuer của ${expected.provider} trong cấu hình project`,
    );
  }

  const known = cache.get(source.cacheKey);
  const kidMissing =
    kid !== undefined &&
    known !== undefined &&
    !known.jwks.keys.some((k) => k.kid === kid);

  let keys: CachedKeys;
  try {
    keys = await keysFor({
      ...source,
      now: now.getTime(),
      refresh: kidMissing,
    });
  } catch (err) {
    return rejected(
      "TOKEN_KEYS_UNAVAILABLE",
      err instanceof Error ? err.message : "không lấy được khoá công khai",
    );
  }

  if (unverified.iss !== keys.issuer) {
    return rejected(
      "TOKEN_ISSUER_UNEXPECTED",
      expected.kind === "cluster"
        ? "iss không phải issuer mà cụm của project này khai"
        : `iss không phải issuer của ${expected.provider} trong cấu hình project`,
    );
  }

  let payload: JWTPayload;
  try {
    const result = await jwtVerify(token, createLocalJWKSet(keys.jwks), {
      issuer: keys.issuer,
      audience: expected.audience,
      // Ba CI SaaS ghim RS256 (đã đọc tại discovery document của họ); nhánh cụm lấy danh sách TỪ CỤM rồi
      // giao với allowlist. Cả hai đường đều đóng lớp alg-confusion, và danh sách rỗng thì `jose` cũng
      // từ chối (đã đo) — nhưng nhánh cụm đã trả 503 từ trước đó.
      algorithms: [...keys.algorithms],
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

  if (expected.kind === "provider") {
    const repo = claimString(payload, expected.repoClaim.name);
    if (repo !== expected.repoClaim.value) {
      return rejected(
        "TOKEN_CLAIM_MISMATCH",
        `${expected.repoClaim.name} của token không khớp cấu hình project`,
      );
    }
  } else if (claimString(payload, "sub") !== expected.subject) {
    /**
     * Phép kiểm đáng tiền nhất của nhánh cụm.
     *
     * Thiếu nó thì mọi pod trong cụm — kể cả chính ứng dụng đang được deploy — xin được token với `aud`
     * của webhook rồi tự deploy image bất kỳ. Thông điệp mang CHỦ THỂ nhận được (một claim, không phải
     * token — I24 vẫn nguyên) vì không có nó thì một lượt chạy Tekton thiếu cờ `--serviceaccount` là một
     * lần 401 không ai truy được nguyên nhân.
     */
    return rejected(
      "TOKEN_CLAIM_MISMATCH",
      `sub của token là ${String(claimString(payload, "sub"))}, không phải ${expected.subject}`,
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
    issuer: keys.issuer,
    tokenId,
    expiresAt: new Date(exp * 1000),
    /**
     * Git ref LẤY TỪ CLAIM. Nhánh cụm luôn `null`: token ServiceAccount không mang claim ref nào, nên lớp
     * này chứng minh LƯỢT CHẠY ở trong cụm của project, **không** chứng minh nhánh (§8.3, §16).
     */
    ref:
      expected.kind === "cluster" || expected.refClaim === null
        ? null
        : claimString(payload, expected.refClaim),
  };
}
