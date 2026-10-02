import { fileURLToPath } from "node:url";
import type { Request } from "express";
import { env } from "@udp/config";
import type {
  MetricsSeriesProvider,
  MetricsSource,
} from "@udp/metrics-provider";
import type { MetricQueries } from "@udp/shared-types";
import {
  createFlagServiceClient,
  type FlagServiceClient,
} from "./clients/flag-service.client.js";
import { createEgressFetch } from "./egress/egress.js";
import { createMetricsFor } from "./metrics-source.js";
import {
  oidcIssuerFromConfig,
  type OidcIssuer,
} from "../modules/oidc/oidc.issuer.js";
import {
  createCloudPlatform,
  type CloudPlatform,
} from "../modules/cloud/cloud.platform.js";
import {
  createRegistry,
  type DomainAdapterRegistry,
} from "../modules/domain/domain-adapter.registry.js";
import type { ClusterAccess } from "@udp/adapter-core";
import type { EnqueueDeploy } from "../modules/cicd/deploy.service.js";
import type { EnqueueJob } from "../modules/provisioning/provisioning.service.js";
import {
  createRepoSourceFactory,
  type RepoSourceFactory,
} from "../modules/golden-path/repo-source.js";
import type { ClusterTokenIssuer } from "../modules/cluster/cluster-token.js";
import { platformProbeFromEnv, type PlatformProbe } from "./platform-probe.js";
import { smtpMailer, type Mailer } from "./mail/mailer.js";
import {
  githubOAuth,
  type GithubOAuth,
} from "../modules/auth/github.client.js";

/**
 * Phụ thuộc RA NGOÀI tiến trình của Service 1 — thứ test phải thay được mà không
 * dựng hạ tầng thật: nguồn metrics (probe pha 1, §7.4) và Service 2 (`track` của
 * Luồng 5, bốn lời gọi ghi cấu hình flag của Luồng 4 [v4.5]).
 *
 * Vì sao qua `app.locals` chứ không qua tham số của router: router của S1 là
 * singleton cấp module, gắn một lần (`projectRouter.use("/:id", rolloutRouter)`),
 * và lint I10 (`project-route-guard`) đọc chính dạng khai báo đó để chứng minh mọi
 * route dưới `/:id` có `requireMinProjectRole`. Một factory nhận deps sẽ vừa lọt
 * lint vừa chồng router mỗi lần `createApp()` (QA Plan #18). Mỗi app giữ deps
 * của RIÊNG nó; handler đọc qua `appDepsOf(req)`.
 */
export interface AppDeps {
  /**
   * Provider cho một lần probe — tạo mới mỗi lời gọi, KHÔNG cache theo
   * `metricBase`: ở đây khoá đến từ request người dùng, cache là rò bộ nhớ theo
   * số chuỗi khác nhau họ gửi (QA Plan #18). `source` là nguồn của environment
   * suy từ binding `metrics.query` (Plan #31); `null` khi project chưa có binding.
   * [v4.11, Plan #39] `scope` nói cluster của project nào khi nguồn nằm TRONG cluster.
   */
  metricsFor(
    source: MetricsSource | null,
    metricQueries: MetricQueries | undefined,
    scope: { projectId: string },
  ): MetricsSeriesProvider;
  flagService: FlagServiceClient;
  /**
   * [v4.11] UDP là OIDC issuer (Plan #26 QĐ-5) — `null` khi chưa cấu hình: federation
   * GCP/Azure khi ấy báo lỗi cấu hình, credential tĩnh và AWS vẫn chạy.
   */
  oidcIssuer: OidcIssuer | null;
  /**
   * [v4.11] Adapter theo (cloud, region) và bước đổi credential (Plan #26 QĐ-6/7) — test
   * tiêm bản dựng trên cổng mô phỏng, không bao giờ gọi cloud thật.
   */
  cloud: CloudPlatform;
  /**
   * [v4.11] Registry Domain Adapter (Plan #27 QĐ-2) — nạp MỘT lần rồi nhớ; `index.ts` chờ
   * nó và kiểm registry ↔ catalog trước khi mở cổng. Test tiêm registry trên cây fixture.
   */
  domainRegistry: () => Promise<DomainAdapterRegistry>;
  /**
   * [v4.11] Provisioning (Plan #28): dải egress mà API endpoint cluster khách mở cho, và cổng
   * gửi job sang hàng đợi — `null` khi tiến trình không chạy hàng đợi (đối soát gửi thay).
   */
  provisioning: ProvisioningRuntime;
  /**
   * [v4.11] Nguồn repo cho quét Import Existing (Plan #48 QĐ-5) — GitHub/GitLab qua `fetch`; test
   * tiêm nguồn trong bộ nhớ, không bao giờ gọi mạng thật.
   */
  repoSource: RepoSourceFactory;
  /**
   * [v4.12, Plan #61 61d-2a] `fetch` đã bọc hàng rào egress, cho đường HTTP của tiến trình API.
   *
   * Trước đợt này `createEgressFetch()` chỉ được nối vào worker job, nên tiến trình phục vụ webhook không
   * có bản đã bọc. Trusted Deploy đi lấy khoá công khai từ một địa chỉ mà cấu hình của project quyết định
   * (`tool_config.gitlabUrl`), tức đúng hình dạng SSRF mà §12.1 T11 mô tả và `createEgressFetch` chặn
   * ngay trong `lookup`. Tiêm vào theo khuôn `repoSource`: test đưa một bản giả và khẳng định được "không
   * một lời gọi mạng nào phát ra".
   */
  egressFetch: typeof fetch;
  /**
   * [v4.11, Plan #53 QĐ-6] Tín hiệu của CHÍNH cụm đang chạy UDP cho Bảng điều khiển nền tảng (node,
   * PVC PostgreSQL, CronJob sao lưu, Certificate) — nạp một lần theo môi trường chạy; test tiêm bản giả.
   */
  platform: () => Promise<PlatformProbe>;
  /**
   * [v4.12, Plan #60 QĐ-7, QĐ-8] Đường ra ngoài của đăng nhập: thư đặt lại mật khẩu (SMTP) và OAuth GitHub. `null` khi
   * chưa cấu hình — tính năng tắt và `GET /auth/options` báo cho Portal ẩn nút. Test tiêm bản giả, không gửi thư hay
   * gọi GitHub thật.
   */
  auth: AuthRuntime;
}

export interface AuthRuntime {
  mailer: Mailer | null;
  github: GithubOAuth | null;
}

export type WithCluster = <T>(
  projectId: string,
  use: (access: ClusterAccess) => Promise<T>,
) => Promise<T>;

export interface ProvisioningRuntime {
  egressCidrs: readonly string[];
  enqueue: EnqueueJob;
  /** [v4.11] Cổng sang hàng đợi `udp-deploy` (Plan #36) — `null` cùng nghĩa với `enqueue` */
  enqueueDeploy: EnqueueDeploy;
  /**
   * [v4.11, Plan #38] Cluster của project cho MỘT việc đọc (hỏi chi phí qua proxy) — cần
   * credential cloud, nên chỉ tiến trình chạy worker cung cấp; `null` ⇒ route trả 503.
   */
  withCluster: WithCluster | null;
  /**
   * Quét drift NGAY một domain (Plan #30) — cần cluster, nên chỉ tiến trình chạy worker
   * cung cấp; `null` ⇒ route trả 503 thay vì giả vờ đã quét.
   */
  scanDrift: ((projectId: string, domainType: string) => Promise<void>) | null;
  /**
   * [v4.11, Plan #51] Bound SA token cho Service 3 (`POST /internal/clusters/:id/token`) — cần credential cloud,
   * nên chỉ tiến trình chạy worker cung cấp; `null` ⇒ route trả 503.
   */
  clusterToken: ClusterTokenIssuer | null;
  /**
   * [v4.11, Plan #51 QĐ-9] URL gốc của Service 3 nhìn từ cluster tenant — webhook gate của `Canary` (Flagger)
   * trỏ về đây (`PD_CONTROLLER_WEBHOOK_URL`); `null` ⇒ rollout SERVICE_LEVEL với Flagger trả 422.
   */
  flaggerGateBaseUrl: string | null;
}

/** Gốc cây adapter của sản phẩm: `src/modules` (hay `dist/modules` khi đã build) */
const MODULES_ROOT = fileURLToPath(new URL("../modules", import.meta.url));

/** Một lời hứa cho cả tiến trình — nạp lại cây adapter mỗi request là I/O vô ích */
function memoized<T>(load: () => Promise<T>): () => Promise<T> {
  let pending: Promise<T> | undefined;
  return () => (pending ??= load());
}

/** Bản thật, dựng từ cấu hình — `createApp()` dùng khi không được truyền deps */
export function defaultAppDeps(): AppDeps {
  const oidcIssuer = oidcIssuerFromConfig(env);
  return {
    // Không có worker thì không có đường tới cluster — `index.ts` tiêm bản có (Plan #39)
    metricsFor: createMetricsFor(null),
    flagService: createFlagServiceClient({
      baseUrl: env.FLAG_SERVICE_URL,
      secret: env.INTERNAL_SERVICE_SECRET,
    }),
    oidcIssuer,
    cloud: createCloudPlatform(env, oidcIssuer),
    domainRegistry: memoized(() => createRegistry({ root: MODULES_ROOT })),
    provisioning: {
      egressCidrs: env.UDP_EGRESS_CIDRS,
      enqueue: null,
      enqueueDeploy: null,
      withCluster: null,
      scanDrift: null,
      clusterToken: null,
      flaggerGateBaseUrl: env.PD_CONTROLLER_WEBHOOK_URL ?? null,
    },
    repoSource: createRepoSourceFactory(),
    egressFetch: createEgressFetch(),
    platform: memoized(() => platformProbeFromEnv()),
    auth: {
      mailer:
        env.SMTP_URL === undefined || env.MAIL_FROM === undefined
          ? null
          : smtpMailer(env.SMTP_URL, env.MAIL_FROM),
      github:
        env.GITHUB_CLIENT_ID === undefined ||
        env.GITHUB_CLIENT_SECRET === undefined
          ? null
          : githubOAuth(env.GITHUB_CLIENT_ID, env.GITHUB_CLIENT_SECRET),
    },
  };
}

const APP_DEPS = "udpAppDeps";

export function setAppDeps(
  locals: Record<string, unknown>,
  deps: AppDeps,
): void {
  locals[APP_DEPS] = deps;
}

export function appDepsOf(req: Request): AppDeps {
  const deps = (req.app.locals as Record<string, unknown>)[APP_DEPS];
  if (deps === undefined) {
    // Lỗi lắp ráp, không phải lỗi người dùng: createApp() luôn đặt deps
    throw new Error("AppDeps chưa được gắn — app không dựng qua createApp()");
  }
  return deps as AppDeps;
}
