import { OpenFeature } from "@openfeature/server-sdk";
import {
  configBody,
  createProviderForTesting,
  flag,
  InMemoryTransport,
  ScriptedStream,
} from "../../src/testing.js";

/**
 * Ứng dụng khách BẬT `reportStats` (mặc định) rồi QUÊN `OpenFeature.close()` —
 * một CLI, một script build, một test của khách. Tiến trình phải thoát ngay sau
 * lần đánh giá cuối: đồng hồ báo cáo 60 giây mà không `unref()` giữ event loop
 * sống và lệnh của khách treo một phút (R19 (b)).
 *
 * Transport là bộ giả trong tiến trình: không socket nào, nên thứ DUY NHẤT có thể
 * giữ event loop lại là timer của provider.
 */
const transport = new InMemoryTransport();
transport.configs.push({
  kind: "ok",
  body: configBody(1, [flag("f")]),
  etag: '"1"',
});
transport.streams.push(new ScriptedStream());
await OpenFeature.setProviderAndWait(
  createProviderForTesting(
    { host: "http://unused", sdkKey: "k" },
    { transport },
  ),
);
const value = await OpenFeature.getClient().getBooleanValue("f", false);
console.log(`đã đánh giá: ${String(value)}`);
