import { EventEmitter } from "node:events";
import { queryTemplates } from "@udp/metrics-provider";
import express from "express";
import { Histogram, Registry } from "prom-client";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { requestStore } from "../src/labels.js";
import {
  REQUEST_DURATION_LABELS,
  REQUEST_DURATION_METRIC,
  udpMetricsMiddleware,
  UNMATCHED_ROUTE,
} from "../src/metrics.js";

/**
 * `udpMetricsMiddleware` (§6.6) — số series đúng công thức (1 tổng + mỗi tracked
 * flag đã đánh giá, không nhân chéo), key thô, route là MẪU, ghi đúng một lần,
 * và HỢP ĐỒNG nhãn với truy vấn của Service 3 (§7.4).
 */

async function seriesOf(registry: Registry) {
  const metric = await registry.getSingleMetricAsString(
    REQUEST_DURATION_METRIC,
  );
  return metric
    .split("\n")
    .filter((l) => l.startsWith(`${REQUEST_DURATION_METRIC}_count{`));
}

function app(registry: Registry) {
  const a = express();
  a.use(
    udpMetricsMiddleware({
      registry,
      serviceName: "checkout",
      serviceVersion: "1.4.0",
    }),
  );
  const router = express.Router();
  router.get("/items/:id", (_req, res) => {
    const store = requestStore.getStore();
    store?.flags.set("checkout-v2", "on");
    store?.flags.set("new-price", "off");
    res.json({ ok: true });
  });
  a.use("/api", router);
  return a;
}

describe("udpMetricsMiddleware", () => {
  it('1 series tổng ff="" + mỗi tracked flag một series; key thô; route là mẫu, không URL thô', async () => {
    const registry = new Registry();
    await request(app(registry)).get("/api/items/42").expect(200);
    const series = await seriesOf(registry);
    expect(series).toHaveLength(3);
    expect(series.join("\n")).toContain('http_route="/api/items/:id"');
    expect(series.join("\n")).not.toContain("/api/items/42");
    const ff = series.map((s) => /ff="([^"]*)"/.exec(s)?.[1]).sort();
    expect(ff).toEqual(["", "checkout-v2=on", "new-price=off"]);
  });

  it("route không khớp ⇒ UNMATCHED", async () => {
    const registry = new Registry();
    await request(app(registry)).get("/khong-co/123").expect(404);
    expect((await seriesOf(registry)).join("\n")).toContain(
      `http_route="${UNMATCHED_ROUTE}"`,
    );
  });

  it("tạo middleware hai lần trên cùng registry không ném (histogram lấy lại)", () => {
    const registry = new Registry();
    udpMetricsMiddleware({ registry });
    expect(() => udpMetricsMiddleware({ registry })).not.toThrow();
  });

  it("client huỷ trước khi xong ⇒ 499, ghi đúng MỘT lần dù finish và close cùng bắn", async () => {
    const registry = new Registry();
    const mw = udpMetricsMiddleware({
      registry,
      serviceName: "s",
      serviceVersion: "v",
    });
    const aborted = Object.assign(new EventEmitter(), {
      statusCode: 200,
      headersSent: false,
    });
    mw({ method: "GET" }, aborted, () => undefined);
    aborted.emit("close");
    aborted.emit("close");
    const finished = Object.assign(new EventEmitter(), {
      statusCode: 201,
      headersSent: true,
    });
    mw({ method: "GET" }, finished, () => undefined);
    finished.emit("finish");
    finished.emit("close");
    const series = await seriesOf(registry);
    expect(
      series.map((s) => /status_code="(\d+)"[^}]*} (\d+)/.exec(s)?.slice(1)),
    ).toEqual(
      expect.arrayContaining([
        ["499", "1"],
        ["201", "1"],
      ]),
    );
  });

  it("hợp đồng nhãn với truy vấn của Service 3 (§7.4): cùng tên metric, mọi nhãn truy vấn dùng đều được phát (trừ namespace — Prometheus gắn)", () => {
    const q = queryTemplates();
    const queries = [
      q.requestCount(
        {
          namespace: "n",
          workloadName: "w",
          version: "1",
          flagKey: "f",
          variantKey: "on",
        },
        60,
      ),
      q.errorRate({ namespace: "n", workloadName: "w", version: "1" }, 60),
    ].join(" ");
    expect(queries).toContain(REQUEST_DURATION_METRIC);
    const used = [...queries.matchAll(/([a-z_]+)(?:=~|=)"/g)].map(
      (m) => m[1] as string,
    );
    const emitted = new Set<string>(REQUEST_DURATION_LABELS);
    const missing = [...new Set(used)].filter(
      (l) => l !== "namespace" && !emitted.has(l),
    );
    expect(missing).toEqual([]);
  });
});

describe("udpMetricsMiddleware — hồi quy QA code Plan #21", () => {
  it("histogram cùng tên nhưng thiếu nhãn ff ⇒ NÉM rõ lúc dựng (không nuốt mọi lần ghi)", () => {
    const registry = new Registry();
    new Histogram({
      name: REQUEST_DURATION_METRIC,
      help: "của ứng dụng",
      labelNames: ["http_route", "http_request_method"],
      registers: [registry],
    });
    expect(() => udpMetricsMiddleware({ registry })).toThrow(/thiếu .*ff/);
  });

  it("header đã gửi rồi client cắt (stream 200 dở) ⇒ giữ status đã gửi, không 499", async () => {
    const registry = new Registry();
    const mw = udpMetricsMiddleware({
      registry,
      serviceName: "s",
      serviceVersion: "v",
    });
    const res = Object.assign(new EventEmitter(), {
      statusCode: 200,
      headersSent: true,
    });
    mw({ method: "GET" }, res, () => undefined);
    res.emit("close");
    const series = await seriesOf(registry);
    expect(series.join("\n")).toContain('http_response_status_code="200"');
    expect(series.join("\n")).not.toContain("499");
  });
});
