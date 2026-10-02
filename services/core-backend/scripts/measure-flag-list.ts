import { performance } from "node:perf_hooks";
import { parseArgs } from "node:util";
import { env } from "@udp/config";
import { createPrismaClient } from "@udp/db";
import {
  DEV_GEOMETRY,
  percentile,
  round,
  summarize,
  writeResult,
} from "@udp/experiments";
import { FakeMetricsProvider } from "@udp/metrics-provider/testing";
import { startFlagService } from "@udp/test-support/service";
import { createEgressFetch } from "../src/core/egress/egress.js";
import request from "supertest";
import { createApp } from "../src/app.js";
import { createFlagServiceClient } from "../src/core/clients/flag-service.client.js";
import { API, as, testWorld } from "../tests/helpers/api.js";
import {
  noRepoSource,
  inertCloudPlatform,
  inertProvisioning,
  noDomainAdapters,
  outsidePlatform,
  noExternalAuth,
} from "../tests/helpers/inert-deps.js";

/**
 * Phép đo `portal-pagination` (Plan #41 QĐ-6) — thời gian tải danh sách flag ở 200 flag × 3
 * environment, theo đúng lời gọi Portal gửi:
 *
 * - `page`: trang đầu 50 flag kèm stats (`include=stats` — thêm một lời gọi S1 → S2), thứ trang
 *   Flag gửi từ Plan #41;
 * - `count`: `limit=1` đọc `total` — thanh số và tổng quan;
 * - `fullList`: HAI trang 100 kèm stats — cách Portal tải trọn danh sách trước Plan #41, để so.
 *
 *   pnpm --filter @udp/core-backend measure:flag-list [--flags 200 --runs 50 --warmup 5]
 *
 * S1 trong tiến trình (supertest, không mạng), Service 2 tiến trình con thật, database dev. Số
 * trên máy dev tới database ở Singapore là DEV-GEOMETRY (§14, §16): RTT database chiếm phần lớn.
 * Ngưỡng của sổ nợ: p95 ≤ 500 ms.
 */

const { values } = parseArgs({
  options: {
    flags: { type: "string", default: "200" },
    runs: { type: "string", default: "50" },
    warmup: { type: "string", default: "5" },
    note: { type: "string" },
  },
});
const FLAGS = Number(values.flags);
const RUNS = Number(values.runs);
const WARMUP = Number(values.warmup);
const THRESHOLD_MS = 500;

const admin = createPrismaClient({
  connectionString: env.DATABASE_URL,
  max: 2,
  cacheKey: "__udp_prisma_measure_flag_list",
});

async function main(): Promise<void> {
  const s2 = await startFlagService();
  const app = createApp({
    metricsFor: () => new FakeMetricsProvider(),
    flagService: createFlagServiceClient({
      baseUrl: s2.baseUrl,
      secret: env.INTERNAL_SERVICE_SECRET,
    }),
    oidcIssuer: null,
    cloud: inertCloudPlatform,
    domainRegistry: noDomainAdapters,
    provisioning: inertProvisioning,
    repoSource: noRepoSource,
    egressFetch: createEgressFetch(),
    platform: outsidePlatform,
    auth: noExternalAuth,
  });
  const world = testWorld(app, admin);
  try {
    const owner = await world.newActor("measure-list");
    const { projectId, envs } = await world.newProject(owner);
    const dev = envs.dev?.id ?? "";
    for (let i = 0; i < FLAGS; i += 1) {
      await as(
        owner,
        request(app)
          .post(`${API}/projects/${projectId}/flags`)
          .send({
            key: `f-${String(i).padStart(4, "0")}`,
            flagType: "BOOLEAN",
          }),
      ).expect(201);
    }
    const url = `${API}/projects/${projectId}/flags`;
    const get = (query: Record<string, string | number>) =>
      as(owner, request(app).get(url).query(query)).expect(200);

    const shapes: Record<string, () => Promise<unknown>> = {
      page: () =>
        get({ envId: dev, include: "stats", tz: "UTC", limit: 50, offset: 0 }),
      count: () => get({ envId: dev, limit: 1 }),
      fullList: async () => {
        for (const offset of [0, 100]) {
          await get({
            envId: dev,
            include: "stats",
            tz: "UTC",
            limit: 100,
            offset,
          });
        }
      },
    };
    const data: Record<string, unknown> = {
      flags: FLAGS,
      environments: Object.keys(envs).length,
      runs: RUNS,
      warmup: WARMUP,
      thresholdMs: THRESHOLD_MS,
    };
    for (const [name, call] of Object.entries(shapes)) {
      for (let i = 0; i < WARMUP; i += 1) await call();
      const samples: number[] = [];
      for (let i = 0; i < RUNS; i += 1) {
        const t0 = performance.now();
        await call();
        samples.push(performance.now() - t0);
      }
      const sorted = [...samples].sort((a, b) => a - b);
      const summary = summarize(samples);
      data[name] = {
        p95Ms: round(percentile(sorted, 0.95), 1),
        p50Ms: round(summary.p50, 1),
        p99Ms: round(summary.p99, 1),
        maxMs: round(summary.max, 1),
        samplesMs: samples.map((v) => round(v, 1)),
      };
      console.log(
        `${name}: p50 ${String(round(summary.p50, 1))} ms, p95 ${String(round(percentile(sorted, 0.95), 1))} ms`,
      );
    }
    const file = writeResult(
      "portal-pagination",
      DEV_GEOMETRY,
      data,
      values.note,
    );
    console.log(`đã ghi ${file}`);
  } finally {
    await world.cleanup();
    await s2.stop();
    await admin.$disconnect();
  }
}

await main();
