import {
  InMemoryProvider,
  OpenFeature,
  type Client,
} from "@openfeature/server-sdk";
import { UDPRequestLabelHook } from "@udp/openfeature-provider";
import { Registry } from "prom-client";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { ChaosState } from "../src/chaos.js";
import { RolloutObserver } from "../src/observer.js";
import { Timeline } from "../src/timeline.js";

/**
 * Sample-app với provider TRONG BỘ NHỚ của OpenFeature (không mạng): route, nhãn
 * `ff`, chaos, dòng thời gian đo T3. Hook nhãn gắn tay ở đây — ngoài đời provider
 * UDP tự gắn nó.
 */

const FLAG = "checkout-v2";
const flagConfig = (onUsers: (key: string) => boolean) => ({
  [FLAG]: {
    variants: { on: true, off: false },
    defaultVariant: "off",
    disabled: false,
    contextEvaluator: (ctx: { targetingKey?: string }) =>
      onUsers(ctx.targetingKey ?? "") ? "on" : "off",
  },
});

let provider: InMemoryProvider;
let client: Client;

beforeEach(async () => {
  provider = new InMemoryProvider(flagConfig((k) => k.startsWith("on-")));
  await OpenFeature.setProviderAndWait("sample-app-test", provider);
  client = OpenFeature.getClient("sample-app-test");
  client.addHooks(new UDPRequestLabelHook(() => new Set([FLAG])));
});

afterEach(async () => {
  for (const o of observers.splice(0)) o.stop();
  await OpenFeature.close();
});

const observers: RolloutObserver[] = [];

function build(chaosEnabled = true, probeUsers = 100) {
  const registry = new Registry();
  const timeline = new Timeline();
  const chaos = new ChaosState(timeline, () => 0);
  const observer = new RolloutObserver(
    client,
    FLAG,
    timeline,
    probeUsers,
    () => chaos.describe().blastRadius,
  );
  observer.start();
  observers.push(observer);
  const app = createApp({
    client,
    registry,
    chaos,
    observer,
    timeline,
    checkoutFlagKey: FLAG,
    chaosEnabled,
    serviceName: "sample-app",
  });
  return { app, timeline, observer };
}

describe("route nghiệp vụ", () => {
  it("sản phẩm; checkout cần x-user-id; nhánh on là code mới", async () => {
    const { app } = build();
    const list = await request(app).get("/api/products").expect(200);
    expect(list.body.items).toHaveLength(10);
    await request(app).get("/api/products/khong-co").expect(404);
    await request(app).post("/api/checkout").expect(400);
    const on = await request(app)
      .post("/api/checkout")
      .set("x-user-id", "on-1")
      .expect(200);
    expect(on.body.algorithm).toBe("v2");
    const off = await request(app)
      .post("/api/checkout")
      .set("x-user-id", "u-1")
      .expect(200);
    expect(off.body.algorithm).toBe("v1");
  });

  it("/metrics có series ff theo nhánh; /healthz, /metrics, /chaos KHÔNG vào histogram", async () => {
    const { app } = build();
    await request(app).get("/healthz").expect(200);
    await request(app).post("/chaos/reset").expect(200);
    await request(app)
      .post("/api/checkout")
      .set("x-user-id", "on-1")
      .expect(200);
    await request(app)
      .post("/api/checkout")
      .set("x-user-id", "u-1")
      .expect(200);
    const text = (await request(app).get("/metrics").expect(200)).text;
    const series = text
      .split("\n")
      .filter((l) =>
        l.startsWith("http_server_request_duration_seconds_count{"),
      )
      .join("\n");
    expect(series).toContain(`ff="${FLAG}=on"`);
    expect(series).toContain(`ff="${FLAG}=off"`);
    expect(series).toContain('service_name="sample-app"');
    for (const hidden of ["/healthz", "/metrics", "/chaos"]) {
      expect(series).not.toContain(`http_route="${hidden}`);
    }
  });
});

describe("chaos", () => {
  it("tắt mặc định ⇒ 404", async () => {
    const { app } = build(false);
    await request(app).post("/chaos/error-rate?p=1").expect(404);
  });

  it("error-rate scope flag-on: nhánh on 500, nhánh off 200; tham số sai ⇒ 400", async () => {
    const { app } = build();
    await request(app).post("/chaos/error-rate?p=2").expect(400);
    await request(app).post("/chaos/error-rate?p=1").expect(200);
    await request(app)
      .post("/api/checkout")
      .set("x-user-id", "on-1")
      .expect(500);
    await request(app)
      .post("/api/checkout")
      .set("x-user-id", "u-1")
      .expect(200);
    await request(app).post("/chaos/error-rate?p=1&scope=shared").expect(200);
    await request(app)
      .post("/api/checkout")
      .set("x-user-id", "u-1")
      .expect(500);
  });

  it("T3: nhóm dò chốt lúc bơm lỗi; rollback đưa nhóm con về off ⇒ cohort-cleared", async () => {
    // Nhóm dò `probe-0..99`: 50 user đầu ở on
    await provider.putConfiguration(
      flagConfig((k) => /^probe-([0-9]|[1-4][0-9])$/.test(k)),
    );
    const { app, timeline, observer } = build(true, 100);
    const on = await request(app).post("/chaos/error-rate?p=1").expect(200);
    expect(on.body.cohort).toBe(50);

    // "Rollback": mọi người về off — provider phát CONFIGURATION_CHANGED
    await provider.putConfiguration(flagConfig(() => false));
    // Sự kiện của SDK có thể tới sau: chờ theo điều kiện (có hạn), rồi chờ hàng
    // đợi của observer xong
    const deadline = Date.now() + 5_000;
    while (!timeline.list().some((e) => e.type === "cohort-cleared")) {
      if (Date.now() > deadline) throw new Error("không thấy cohort-cleared");
      await new Promise((r) => setTimeout(r, 5));
    }
    await observer.settled();
    const events = timeline.list();
    expect(events.find((e) => e.type === "config-changed")).toMatchObject({
      direction: "decrease",
      cohortRemaining: 0,
      onShare: 0,
    });
    expect(events.map((e) => e.type)).toEqual([
      "fault-on",
      "cohort",
      "config-changed",
      "cohort-cleared",
    ]);
    const body = (await request(app).get("/chaos/timeline").expect(200)).body;
    expect(body.events).toHaveLength(4);
    expect(events.at(-1)).toMatchObject({ blast: { servedOn: 0 } });
  });
});
