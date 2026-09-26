import { fileURLToPath } from "node:url";
import type { Request } from "express";
import { env } from "@udp/config";
import type { MetricsProvider, MetricsSource } from "@udp/metrics-provider";
import type { MetricQueries } from "@udp/shared-types";
import {
  createFlagServiceClient,
  type FlagServiceClient,
} from "./clients/flag-service.client.js";
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
  ): MetricsProvider;
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
