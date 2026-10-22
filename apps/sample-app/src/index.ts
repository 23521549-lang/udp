import "dotenv/config";
import { OpenFeature } from "@openfeature/server-sdk";
import { UDPFeatureFlagProvider } from "@udp/openfeature-provider";
import { collectDefaultMetrics, register } from "prom-client";
import { createApp } from "./app.js";
import { ChaosState } from "./chaos.js";
import { loadConfig } from "./config.js";
import { RolloutObserver } from "./observer.js";
import { Timeline } from "./timeline.js";

/**
 * Khởi động theo Golden Path (§11) [v4.8]: provider trước, `setProviderAndWait`
 * trong try/catch — Service 2 không tới được thì ứng dụng VẪN chạy với default
 * trong code (provider tự thử nền và phát READY khi có cấu hình).
 */

const config = loadConfig();
collectDefaultMetrics({ register });

const provider = new UDPFeatureFlagProvider({
  host: config.UDP_FLAG_HOST,
  sdkKey: config.UDP_SDK_KEY,
  logger: console,
});
try {
  await OpenFeature.setProviderAndWait(provider);
} catch (err) {
  console.warn("UDP flags chưa sẵn sàng — chạy với default", err);
}

const client = OpenFeature.getClient();
const timeline = new Timeline();
const chaos = new ChaosState(timeline);
const observer = new RolloutObserver(
  client,
  config.CHECKOUT_FLAG_KEY,
  timeline,
  config.PROBE_USERS,
  () => chaos.describe().blastRadius,
);
observer.start();

const app = createApp({
  client,
  registry: register,
  chaos,
  observer,
  timeline,
  checkoutFlagKey: config.CHECKOUT_FLAG_KEY,
  chaosEnabled: config.CHAOS_ENABLED,
  serviceName: config.OTEL_SERVICE_NAME,
});

const server = app.listen(config.PORT, () => {
  console.info(
    `sample-app nghe cổng ${String(config.PORT)} (service_name=${config.OTEL_SERVICE_NAME}, chaos=${String(config.CHAOS_ENABLED)})`,
  );
});

let stopping = false;
const shutdown = (): void => {
  if (stopping) return;
  stopping = true;
  observer.stop();
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
