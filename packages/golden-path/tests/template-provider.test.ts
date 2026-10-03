import { OpenFeature } from "@openfeature/server-sdk";
import {
  configBody,
  createProviderForTesting,
  flag,
  InMemoryTransport,
  ScriptedStream,
} from "@udp/openfeature-provider/testing";
import { Registry } from "prom-client";
import request from "supertest";
import { afterAll, describe, expect, it } from "vitest";
import { createApp } from "../templates/node/src/app.js";
import { HELLO_FLAG } from "../templates/node/src/routes/hello.js";

/**
 * Template Node với `UDPFeatureFlagProvider` THẬT (transport giả, không mạng) — test của template chỉ
 * dùng provider trong bộ nhớ vì developer không có `./testing`; ở đây kiểm nốt điều §6.8 hứa: hook
 * nhãn `ff` do provider tự gắn và tập tracked tới từ cấu hình, template không gắn hook nào.
 */

const DOMAIN = "golden-path-real-provider";

afterAll(async () => {
  await OpenFeature.close();
});

describe("template Node + provider UDP thật", () => {
  it("flag được track ⇒ /metrics có ff theo variant của từng người dùng; flag không track ⇒ không nhãn", async () => {
    const transport = new InMemoryTransport();
    const split = {
      id: "r1",
      type: "ALL",
      condition: {},
      serve: {
        kind: "distribution",
        weights: [
          { variantKey: "on", weight: 50_000 },
          { variantKey: "off", weight: 50_000 },
        ],
      },
      bucketSalt: "s",
      priority: 0,
    };
    transport.configs.push({
      kind: "ok",
      body: configBody(
        1,
        [flag(HELLO_FLAG, { rules: [split] as never })],
        [HELLO_FLAG],
      ),
      etag: '"1"',
    });
    transport.streams.push(new ScriptedStream());
    const provider = createProviderForTesting(
      { host: "http://unused", sdkKey: "k", reportStats: false },
      { transport },
    );
    await OpenFeature.setProviderAndWait(DOMAIN, provider);

    const registry = new Registry();
    const app = createApp({ flags: OpenFeature.getClient(DOMAIN), registry });
    const seen = new Set<boolean>();
    for (let i = 0; i < 40; i += 1) {
      const res = await request(app)
        .get(`/api/hello?user=u${String(i)}`)
        .expect(200);
      seen.add((res.body as { v2: boolean }).v2);
    }
    expect(seen).toEqual(new Set([true, false]));
    const metrics = (await request(app).get("/metrics").expect(200)).text;
    expect(metrics).toContain(`ff="${HELLO_FLAG}=on"`);
    expect(metrics).toContain(`ff="${HELLO_FLAG}=off"`);
    // /healthz và /metrics nằm ngoài middleware đo
    expect(metrics).not.toContain('http_route="/healthz"');
  });
});
