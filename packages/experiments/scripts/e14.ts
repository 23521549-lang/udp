import { parseArgs } from "node:util";
import { OpenFeature } from "@openfeature/server-sdk";
import type { SnapshotFlag } from "@udp/flag-evaluator";
import { requestStore } from "@udp/openfeature-provider";
import {
  REQUEST_DURATION_METRIC,
  udpMetricsMiddleware,
} from "@udp/openfeature-provider/metrics";
import {
  configBody,
  createProviderForTesting,
  InMemoryTransport,
  ScriptedStream,
} from "@udp/openfeature-provider/testing";
import express, { type Express } from "express";
import { Registry } from "prom-client";
import request from "supertest";
import { IN_PROCESS, round, summarize, writeResult } from "../src/index.js";

/**
 * **E14** (§14) [v4.8] — chi phí cardinality của nhãn `ff`, phần đo được KHÔNG
 * cần Prometheus: số series, byte exposition, thời gian dựng `/metrics` phía app.
 * (Dung lượng TSDB sau 1 giờ và scrape duration phía Prometheus: sổ nợ.)
 *
 *   pnpm --filter @udp/experiments e14 [--note "..."]
 *
 * Công thức CHÍNH XÁC (§6.6 v4.8): series = R·S·M·(B+3)·(1+T·V) — mỗi bộ nhãn có
 * B bucket hữu hạn + `+Inf` + `_sum` + `_count`; B = 10, R = 10 route, S = 2
 * status, M = 1 method.
 *
 * Hai nhánh:
 *   (i) ĐỦ TỔ HỢP — mọi (route, status, flag, variant) xuất hiện: kiểm công thức
 *       là trần ĐÚNG (không phải ước lượng).
 *  (ii) THỰC TẾ — provider + hook THẬT, snapshot tổng hợp có T flag tracked, mỗi
 *       flag V variant chia đều bằng rule phân phối, user hash thật, 5% lỗi; mỗi
 *       request đánh giá cả T flag. Báo số series QUAN SÁT được so với trần.
 * T = 50 là đối chứng "gắn nhãn mọi flag" (bản v3) — vì sao trần 3 không tuỳ tiện.
 */

const { values } = parseArgs({ options: { note: { type: "string" } } });

const R = 10;
const S = 2;
const M = 1;
const B = 10;
const TS = [0, 1, 2, 3, 50];
const VS = [2, 4];
const RENDERS = 20;
const REALISTIC_REQUESTS = 2_000;

const predicted = (t: number, v: number) => ({
  total: R * S * M * (B + 3) * (1 + t * v),
  bucket: R * S * M * (B + 1) * (1 + t * v),
});

function appWith(
  registry: Registry,
  handler: (route: number, fail: boolean) => Promise<void>,
): Express {
  const app = express();
  app.use(
    udpMetricsMiddleware({ registry, serviceName: "e14", serviceVersion: "1" }),
  );
  for (let r = 0; r < R; r += 1) {
    app.get(`/r${String(r)}`, (req, res, next) => {
      const fail = req.query["fail"] === "1";
      handler(r, fail)
        .then(() => res.status(fail ? 500 : 200).end())
        .catch(next);
    });
  }
  return app;
}

async function measure(registry: Registry) {
  const text = await registry.metrics();
  const lines = text.split("\n");
  const count = (suffix: string): number =>
    lines.filter((l) => l.startsWith(`${REQUEST_DURATION_METRIC}${suffix}{`))
      .length;
  const renders: number[] = [];
  for (let i = 0; i < RENDERS; i += 1) {
    const t = performance.now();
    await registry.metrics();
    renders.push(performance.now() - t);
  }
  const bucket = count("_bucket");
  return {
    series: { bucket, total: bucket + count("_sum") + count("_count") },
    expositionBytes: Buffer.byteLength(text),
    renderMs: {
      p50: round(summarize(renders).p50, 2),
      max: round(summarize(renders).max, 2),
    },
  };
}

/**
 * (i) Đủ tổ hợp: handler ghi nhãn thẳng vào store của request — đúng thứ hook ghi
 * — mọi flag cùng variant `v`, lặp đủ V variant cho mỗi (route, status)
 */
async function complete(t: number, v: number) {
  const registry = new Registry();
  const app = express();
  app.use(
    udpMetricsMiddleware({ registry, serviceName: "e14", serviceVersion: "1" }),
  );
  for (let r = 0; r < R; r += 1) {
    app.get(`/r${String(r)}`, (req, res) => {
      const variant = String(req.query["v"]);
      const store = requestStore.getStore();
      for (let f = 0; f < t; f += 1)
        store?.flags.set(`flag-${String(f)}`, variant);
      res.status(req.query["fail"] === "1" ? 500 : 200).end();
    });
  }
  for (let r = 0; r < R; r += 1) {
    for (const fail of [false, true]) {
      for (let k = 0; k < v; k += 1) {
        await request(app).get(
          `/r${String(r)}?fail=${fail ? "1" : "0"}&v=v${String(k)}`,
        );
      }
    }
  }
  return measure(registry);
}

/** (ii) Thực tế: provider + hook thật, phân phối hash thật */
async function realistic(t: number, v: number) {
  const flags: SnapshotFlag[] = Array.from({ length: t }, (_, f) => ({
    key: `flag-${String(f)}`,
    type: "STRING",
    isEnabled: true,
    stickinessAttribute: "targetingKey",
    variants: Object.fromEntries(
      Array.from({ length: v }, (_, k) => [`v${String(k)}`, `v${String(k)}`]),
    ),
    defaultVariantKey: "v0",
    rules: [
      {
        id: `r-${String(f)}`,
        type: "ALL",
        condition: {},
        serve: {
          kind: "distribution",
          weights: Array.from({ length: v }, (_, k) => ({
            variantKey: `v${String(k)}`,
            weight: 100_000 / v,
          })),
        },
        bucketSalt: `salt-${String(f)}`,
        priority: 0,
      },
    ],
  }));
  const transport = new InMemoryTransport();
  transport.configs.push({
    kind: "ok",
    body: configBody(
      1,
      flags,
      flags.map((f) => f.key),
    ),
    etag: '"1"',
  });
  transport.streams.push(new ScriptedStream());
  const domain = `e14-${String(t)}-${String(v)}`;
  await OpenFeature.setProviderAndWait(
    domain,
    createProviderForTesting(
      // Ghim TẮT: E14 đo số series và thời gian dựng `/metrics`, không đo telemetry
      { host: "http://unused", sdkKey: "k", reportStats: false },
      { transport },
    ),
  );
  const client = OpenFeature.getClient(domain);
  const registry = new Registry();
  let user = "";
  const app = appWith(registry, async () => {
    for (const flag of flags) {
      await client.getStringDetails(flag.key, "default", {
        targetingKey: user,
      });
    }
  });
  let seed = 42;
  const random = (): number => {
    seed = (seed * 1_103_515_245 + 12_345) % 2 ** 31;
    return seed / 2 ** 31;
  };
  for (let i = 0; i < REALISTIC_REQUESTS; i += 1) {
    user = `user-${String(Math.floor(random() * 1_000))}`;
    const route = Math.floor(random() * R);
    const fail = random() < 0.05;
    await request(app).get(`/r${String(route)}?fail=${fail ? "1" : "0"}`);
  }
  await OpenFeature.clearProviders();
  return measure(registry);
}

const cells = [];
for (const v of VS) {
  for (const t of TS) {
    const expected = predicted(t, v);
    const full = await complete(t, v);
    const real = await realistic(t, v);
    const cell = {
      T: t,
      V: v,
      predicted: expected,
      complete: full,
      completeMatchesFormula: full.series.total === expected.total,
      realistic: real,
      realisticShareOfCeiling: round(real.series.total / expected.total, 3),
    };
    console.log(
      `T=${String(t).padStart(2)} V=${String(v)} — dự đoán ${String(expected.total)} | đủ tổ hợp ${String(full.series.total)} (${cell.completeMatchesFormula ? "khớp" : "LỆCH"}) ${String(full.expositionBytes)} B, render ${String(full.renderMs.p50)} ms | thực tế ${String(real.series.total)} (${String(cell.realisticShareOfCeiling)} trần)`,
    );
    cells.push(cell);
  }
}
const file = writeResult(
  "E14",
  IN_PROCESS,
  {
    method: {
      formula: "R·S·M·(B+3)·(1+T·V)",
      R,
      S,
      M,
      B,
      rendersPerCell: RENDERS,
      realisticRequests: REALISTIC_REQUESTS,
      realisticErrorRate: 0.05,
      notMeasuredHere:
        "dung lượng TSDB sau 1 giờ, scrape duration phía Prometheus — sổ nợ E14-prometheus",
    },
    cells,
  },
  values.note,
);
console.log(`Đã ghi ${file}`);
