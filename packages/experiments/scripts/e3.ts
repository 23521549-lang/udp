import { randomUUID } from "node:crypto";
import { parseArgs } from "node:util";
import { OpenFeature } from "@openfeature/server-sdk";
import { env } from "@udp/config";
import { createPrismaClient } from "@udp/db";
import {
  evaluate,
  prepareSnapshot,
  type SnapshotFlag,
  type SnapshotRule,
} from "@udp/flag-evaluator";
import { requestStore } from "@udp/openfeature-provider";
import {
  configBody,
  createProviderForTesting,
  InMemoryTransport,
  ScriptedStream,
} from "@udp/openfeature-provider/testing";
import {
  createActiveFlag,
  createScratchProject,
  issueSdkKey,
} from "@udp/test-support/fixture";
import {
  startFlagService,
  type RunningService,
} from "@udp/test-support/service";
import {
  DEV_GEOMETRY,
  IN_PROCESS,
  round,
  summarize,
  writeResult,
} from "../src/index.js";

/**
 * **E3** (§14) [v4.8] — độ trễ đánh giá flag.
 *
 *   pnpm --filter @udp/experiments e3 [--skip-remote --rounds 5 --note "..."]
 *
 * Nhánh LOCAL (in-process, không mạng): provider THẬT dựng từ snapshot tổng hợp
 * qua `InMemoryTransport`, gọi qua SDK OpenFeature THẬT (`getBooleanDetails`, hook
 * nhãn `ff` tự gắn chạy trong `requestStore`, tối đa 3 flag tracked — đúng trần
 * thật) trên lưới 1/10/100 flag × 1/10/50 rule; rule CUỐI mới khớp (ca tệ nhất).
 * Cùng lưới qua lõi trần (`evaluate`) để tách phần SDK + provider. Bỏ "k6 trên SDK
 * local" của bản cũ: k6 đo HTTP, còn đánh giá local là một lời gọi trong tiến trình.
 *
 * Mỗi ô đo trong `--rounds` VÒNG, mỗi vòng xáo thứ tự các ô, ép GC giữa hai ô (Node
 * chạy với `--expose-gc`): lần đo đầu cho 100 flag chậm gấp 3 chỉ vì các ô đó chạy
 * SAU các ô nặng — chạy riêng thì như ô 1 flag. Percentile tính trên TOÀN BỘ mẫu
 * gộp của các vòng (không lấy median của từng p99), kèm p50/p99 từng vòng để thấy độ
 * dao động.
 *
 * Nhánh REMOTE (đối chứng): OFREP đơn-flag lên Service 2 tiến trình con, khoá
 * CLIENT, context KHÁC NHAU mỗi lần (không đo cache kết quả), 8 req/s < trần
 * 600/phút theo (khoá, IP). Gồm tra khoá trong database mỗi request — trên máy dev
 * đó là RTT tới Singapore (dev-geometry).
 */

const { values } = parseArgs({
  options: {
    "skip-remote": { type: "boolean", default: false },
    iterations: { type: "string", default: "20000" },
    "remote-samples": { type: "string", default: "400" },
    rounds: { type: "string", default: "3" },
    note: { type: "string" },
  },
});
const ITERATIONS = Number(values.iterations);
const WARM_UP = Math.ceil(ITERATIONS / 10);
const REMOTE_SAMPLES = Number(values["remote-samples"]);
const ROUNDS = Number(values.rounds);
const MAX_TRACKED = 3;

function rule(i: number, last: boolean): SnapshotRule {
  return {
    id: `r${String(i)}`,
    type: "ATTRIBUTE_BASED",
    condition: {
      all: [
        {
          attribute: "plan",
          operator: "eq",
          value: last ? "pro" : `plan-${String(i)}`,
        },
        { attribute: "age", operator: "gte", value: 18 },
      ],
    },
    serve: {
      kind: "distribution",
      weights: [
        { variantKey: "on", weight: 50_000 },
        { variantKey: "off", weight: 50_000 },
      ],
    },
    bucketSalt: randomUUID(),
    priority: i,
  };
}

function flags(flagCount: number, ruleCount: number): SnapshotFlag[] {
  return Array.from({ length: flagCount }, (_, f) => ({
    key: `f${String(f)}`,
    type: "BOOLEAN",
    isEnabled: true,
    stickinessAttribute: "targetingKey",
    variants: { on: true, off: false },
    defaultVariantKey: "off",
    rules: Array.from({ length: ruleCount }, (_, r) =>
      rule(r, r === ruleCount - 1),
    ),
  }));
}

const microseconds = (start: bigint): number =>
  Number(process.hrtime.bigint() - start) / 1_000;

const summaryUs = (samples: readonly number[]) => {
  const s = summarize(samples);
  return {
    p50: round(s.p50),
    p90: round(s.p90),
    p99: round(s.p99),
    max: round(s.max),
  };
};

interface CellSamples {
  core: number[];
  sdk: number[];
  sdkSeconds: number;
}

async function localCell(
  flagCount: number,
  ruleCount: number,
): Promise<CellSamples> {
  const snapshot = flags(flagCount, ruleCount);
  const context = (i: number) => ({
    targetingKey: `u${String(i)}`,
    plan: "pro",
    age: 30,
  });

  // Lõi trần
  const prepared = prepareSnapshot({
    flags: snapshot,
    segments: [],
    trackedFlags: [],
  });
  const core: number[] = [];
  for (let i = 0; i < WARM_UP + ITERATIONS; i += 1) {
    const key = `f${String(i % flagCount)}`;
    const t = process.hrtime.bigint();
    evaluate(prepared, key, context(i), { expectedType: "BOOLEAN" });
    if (i >= WARM_UP) core.push(microseconds(t));
  }

  // Provider + SDK thật; tối đa 3 flag tracked — hook ghi nhãn cho chúng
  const tracked = snapshot
    .slice(0, Math.min(MAX_TRACKED, flagCount))
    .map((f) => f.key);
  const transport = new InMemoryTransport();
  transport.configs.push({
    kind: "ok",
    body: configBody(1, snapshot, tracked),
    etag: '"1"',
  });
  transport.streams.push(new ScriptedStream());
  const domain = `e3-${String(flagCount)}-${String(ruleCount)}`;
  await OpenFeature.setProviderAndWait(
    domain,
    createProviderForTesting(
      { host: "http://unused", sdkKey: "k" },
      { transport },
    ),
  );
  const client = OpenFeature.getClient(domain);
  const sdk: number[] = [];
  // Đồng hồ throughput bắt đầu SAU khởi động — cùng tập lần gọi với phân vị
  let started = process.hrtime.bigint();
  await requestStore.run({ flags: new Map() }, async () => {
    for (let i = 0; i < WARM_UP + ITERATIONS; i += 1) {
      if (i === WARM_UP) started = process.hrtime.bigint();
      const key = `f${String(i % flagCount)}`;
      const t = process.hrtime.bigint();
      await client.getBooleanDetails(key, false, context(i));
      if (i >= WARM_UP) sdk.push(microseconds(t));
    }
  });
  const sdkSeconds = Number(process.hrtime.bigint() - started) / 1e9;
  await OpenFeature.clearProviders();
  return { core, sdk, sdkSeconds };
}

async function remoteArm() {
  const admin = createPrismaClient({
    connectionString: env.DATABASE_URL_DIRECT,
    max: 2,
    cacheKey: `__udp_prisma_e3_${randomUUID()}`,
  });
  const project = await createScratchProject(admin, "exp-e3");
  let s2: RunningService | undefined;
  try {
    s2 = await startFlagService();
    const base = s2.baseUrl;
    for (let f = 0; f < 10; f += 1) {
      await createActiveFlag(base, project.ownerId, {
        projectId: project.projectId,
        key: `f${String(f)}`,
        flagType: "BOOLEAN",
      });
    }
    const clientKey = await issueSdkKey(admin, {
      environmentId: project.environmentId,
      keyType: "CLIENT",
      createdById: project.ownerId,
    });
    const call = async (i: number): Promise<number> => {
      const t = performance.now();
      const res = await fetch(
        `${base}/ofrep/v1/evaluate/flags/f${String(i % 10)}`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${clientKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            context: { targetingKey: `u-${randomUUID()}` },
          }),
        },
      );
      await res.arrayBuffer();
      if (res.status !== 200)
        throw new Error(`OFREP trả ${String(res.status)}`);
      return performance.now() - t;
    };
    for (let i = 0; i < 10; i += 1) await call(i); // khởi động kết nối
    const samples: number[] = [];
    const t0 = performance.now();
    for (let i = 0; i < REMOTE_SAMPLES; i += 1) {
      const due = t0 + (i * 1000) / 8;
      const wait = due - performance.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      samples.push(await call(i));
    }
    const s = summarize(samples);
    return {
      samples: s.n,
      rateRps: 8,
      latencyMs: {
        p50: round(s.p50, 2),
        p90: round(s.p90, 2),
        p99: round(s.p99, 2),
        max: round(s.max, 2),
      },
      note: "gồm tra SDK key trong database mỗi request (không cache khoá — §6.2) — RTT máy dev → Singapore",
    };
  } finally {
    await s2?.stop();
    await project.dispose();
    await admin.$disconnect();
  }
}

const grid = [1, 10, 100].flatMap((f) =>
  [1, 10, 50].map((r) => [f, r] as const),
);
const rounds = new Map<string, CellSamples[]>();
const collect = (globalThis as { gc?: () => void }).gc;
for (let r = 0; r < ROUNDS; r += 1) {
  const order = [...grid].sort(() => Math.random() - 0.5);
  for (const [flagCount, ruleCount] of order) {
    collect?.();
    await new Promise((resolve) => setTimeout(resolve, 200));
    const id = `${String(flagCount)}x${String(ruleCount)}`;
    rounds.set(id, [
      ...(rounds.get(id) ?? []),
      await localCell(flagCount, ruleCount),
    ]);
  }
}
const local = grid.map(([flagCount, ruleCount]) => {
  const cells = rounds.get(`${String(flagCount)}x${String(ruleCount)}`) ?? [];
  const pooled = (pick: (c: CellSamples) => number[]) =>
    cells.flatMap((c) => pick(c));
  const cell = {
    flags: flagCount,
    rulesPerFlag: ruleCount,
    tracked: Math.min(MAX_TRACKED, flagCount),
    coreUs: summaryUs(pooled((c) => c.core)),
    sdkUs: summaryUs(pooled((c) => c.sdk)),
    sdkThroughputPerSecond: Math.round(
      (cells.length * ITERATIONS) /
        cells.reduce((sum, c) => sum + c.sdkSeconds, 0),
    ),
    perRound: cells.map((c) => ({
      coreUs: summaryUs(c.core),
      sdkUs: summaryUs(c.sdk),
    })),
  };
  console.log(
    `${String(flagCount).padStart(3)} flag × ${String(ruleCount).padStart(2)} rule — lõi p50 ${String(cell.coreUs.p50)} µs p99 ${String(cell.coreUs.p99)} µs | SDK p50 ${String(cell.sdkUs.p50)} µs p99 ${String(cell.sdkUs.p99)} µs | ${String(cell.sdkThroughputPerSecond)}/s`,
  );
  return cell;
});
const remote = values["skip-remote"] ? undefined : await remoteArm();
if (remote !== undefined) {
  console.log(
    `OFREP remote — p50 ${String(remote.latencyMs.p50)} ms p99 ${String(remote.latencyMs.p99)} ms (${String(remote.samples)} mẫu)`,
  );
}
const file = writeResult(
  "E3",
  remote === undefined ? IN_PROCESS : `${IN_PROCESS}; remote: ${DEV_GEOMETRY}`,
  {
    method: {
      iterationsPerCellPerRound: ITERATIONS,
      warmUp: WARM_UP,
      rounds: ROUNDS,
      aggregation:
        "percentile trên mẫu gộp của mọi vòng; thứ tự ô xáo mỗi vòng; GC ép giữa các ô",
      percentile: "nearest-rank",
      worstCase: "rule cuối mới khớp",
      sdk: "OpenFeature server-sdk getBooleanDetails qua UDPFeatureFlagProvider (hook ff tự gắn, ≤ 3 flag tracked, trong requestStore)",
    },
    local,
    remote,
  },
  values.note,
);
console.log(`Đã ghi ${file}`);
