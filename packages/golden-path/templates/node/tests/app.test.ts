import {
  InMemoryProvider,
  OpenFeature,
  type Client,
} from "@openfeature/server-sdk";
import { UDPRequestLabelHook } from "@udp/openfeature-provider";
import { Registry } from "prom-client";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { HELLO_FLAG } from "../src/routes/hello.js";

/**
 * Test của ứng dụng — chạy trong pipeline (`npm test`). Provider trong bộ nhớ thay UDP: không mạng.
 * Hook nhãn `ff` gắn tay ở đây; với `UDPFeatureFlagProvider` thật, provider tự gắn nó.
 */

const DOMAIN = "golden-path-test";
let registry: Registry;
/** MỘT client: `getClient()` trả đối tượng mới mỗi lần gọi, hook gắn ở client nào chỉ chạy ở client đó */
let flags: Client;

beforeAll(async () => {
  await OpenFeature.setProviderAndWait(
    DOMAIN,
    new InMemoryProvider({
      [HELLO_FLAG]: {
        variants: { on: true, off: false },
        defaultVariant: "off",
        disabled: false,
        contextEvaluator: (ctx) => (ctx.targetingKey === "vip" ? "on" : "off"),
      },
    }),
  );
  flags = OpenFeature.getClient(DOMAIN);
  flags.addHooks(new UDPRequestLabelHook(() => new Set([HELLO_FLAG])));
  registry = new Registry();
});

afterAll(async () => {
  await OpenFeature.close();
});

describe("ứng dụng Golden Path", () => {
  it("/healthz trả 200", async () => {
    const app = createApp({ flags, registry });
    await request(app).get("/healthz").expect(200, { ok: true });
  });

  it("route nghiệp vụ đánh giá flag theo người dùng; /metrics có nhãn ff của nhánh đã chạy", async () => {
    const app = createApp({ flags, registry });
    const vip = await request(app).get("/api/hello?user=vip").expect(200);
    expect(vip.body).toMatchObject({ v2: true });
    await request(app).get("/api/hello?user=an").expect(200);
    const metrics = await request(app).get("/metrics").expect(200);
    expect(metrics.text).toContain("http_server_request_duration_seconds");
    expect(metrics.text).toContain(`ff="${HELLO_FLAG}=on"`);
    expect(metrics.text).toContain(`ff="${HELLO_FLAG}=off"`);
    expect(metrics.text).toContain('http_route="/api/hello"');
  });
});
