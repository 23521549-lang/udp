import type { Request } from "express";
import { env } from "@udp/config";
import type { MetricsProvider } from "@udp/metrics-provider";
import type { MetricQueries } from "@udp/shared-types";
import {
  createFlagServiceClient,
  type FlagServiceClient,
} from "./clients/flag-service.client.js";
import { metricsFor } from "./metrics-source.js";
import {
  oidcIssuerFromConfig,
  type OidcIssuer,
} from "../modules/oidc/oidc.issuer.js";

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
   * số chuỗi khác nhau họ gửi (QA Plan #18).
   */
  metricsFor(metricQueries: MetricQueries | undefined): MetricsProvider;
  flagService: FlagServiceClient;
  /**
   * [v4.11] UDP là OIDC issuer (Plan #26 QĐ-5) — `null` khi chưa cấu hình: federation
   * GCP/Azure khi ấy báo lỗi cấu hình, credential tĩnh và AWS vẫn chạy.
   */
  oidcIssuer: OidcIssuer | null;
}

/** Bản thật, dựng từ cấu hình — `createApp()` dùng khi không được truyền deps */
export function defaultAppDeps(): AppDeps {
  return {
    metricsFor,
    flagService: createFlagServiceClient({
      baseUrl: env.FLAG_SERVICE_URL,
      secret: env.INTERNAL_SERVICE_SECRET,
    }),
    oidcIssuer: oidcIssuerFromConfig(env),
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
