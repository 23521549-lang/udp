import { OpenFeature } from "@openfeature/server-sdk";
import { UDPFeatureFlagProvider } from "../../src/index.js";

/**
 * Chạy như một ứng dụng khách THẬT theo Golden Path (§11): `await
 * setProviderAndWait` trong try/catch khi Service 2 không tới được (fetch hỏng
 * ngay lập tức). Tiến trình phải sống tới lúc init hết hạn và in dấu hiệu — timer
 * init bị `unref()` thì Node thoát giữa chừng (ESM: mã 13) và không in gì.
 */
const provider = new UDPFeatureFlagProvider({
  host: "http://127.0.0.1:9",
  sdkKey: "udp_sk_probe",
  initTimeoutMs: 300,
  fetch: () => Promise.reject(new TypeError("fetch failed")),
});
try {
  await OpenFeature.setProviderAndWait(provider);
  console.log("init resolved");
} catch {
  console.log("init rejected");
}
await OpenFeature.close();
