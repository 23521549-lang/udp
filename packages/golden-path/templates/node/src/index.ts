import { OpenFeature } from "@openfeature/server-sdk";
import { collectDefaultMetrics, register } from "prom-client";
import { createApp } from "./app.js";
import { startFeatureFlags } from "./telemetry.js";

/**
 * Điểm vào (Golden Path §11.1): provider TRƯỚC, rồi ứng dụng; tắt êm khi Kubernetes gửi SIGTERM
 * (đóng OpenFeature gửi nốt số đếm đánh giá về UDP).
 */

collectDefaultMetrics({ register });
await startFeatureFlags();

const port = Number(process.env["PORT"] ?? 3000);
const app = createApp({ flags: OpenFeature.getClient(), registry: register });
const server = app.listen(port, () => {
  console.info(`nghe cổng ${String(port)}`);
});

let stopping = false;
const shutdown = (): void => {
  if (stopping) return;
  stopping = true;
  server.close(() => {
    OpenFeature.close()
      .catch((err: unknown) => {
        console.warn("đóng OpenFeature lỗi", err);
      })
      .finally(() => {
        process.exit(0);
      });
  });
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
