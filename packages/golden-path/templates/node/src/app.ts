import type { Client } from "@openfeature/server-sdk";
import { udpMetricsMiddleware } from "@udp/openfeature-provider/metrics";
import express, { type Express } from "express";
import type { Registry } from "prom-client";
import { helloRouter } from "./routes/hello.js";

export interface AppDeps {
  /** Client OpenFeature của ứng dụng */
  flags: Client;
  /** Registry mà `/metrics` phơi — cũng là nơi middleware đăng ký histogram */
  registry: Registry;
}

/**
 * Ứng dụng Express theo Golden Path (§11.1).
 *
 * `/healthz` và `/metrics` đăng ký TRƯỚC middleware đo: chúng không phải lưu lượng người dùng, đếm
 * chúng làm bẩn tỉ lệ lỗi mà UDP phân tích khi rollout. Mọi route nghiệp vụ đăng ký SAU middleware.
 *
 * Middleware ghi histogram `http_server_request_duration_seconds` với nhãn `ff` — một series tổng
 * `ff=""` cộng một series cho mỗi flag đang rollout đã được đánh giá trong request. `service_name`
 * lấy từ `OTEL_SERVICE_NAME` (PHẢI bằng tên workload), `service_version` từ `service.version` trong
 * `OTEL_RESOURCE_ATTRIBUTES` — manifest `k8s/deployment.yaml` đặt cả hai.
 */
export function createApp(deps: AppDeps): Express {
  const app = express();
  app.disable("x-powered-by");

  app.get("/healthz", (_req, res) => {
    res.json({ ok: true });
  });
  app.get("/metrics", (_req, res, next) => {
    deps.registry
      .metrics()
      .then((text) => {
        res.set("Content-Type", deps.registry.contentType).end(text);
      })
      .catch(next);
  });

  app.use(udpMetricsMiddleware({ registry: deps.registry }));
  app.use(express.json());
  app.use("/api", helloRouter(deps.flags));
  return app;
}
