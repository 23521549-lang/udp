import { randomUUID } from "node:crypto";
import { parseArgs } from "node:util";
import { env, METRICS_PROVIDER } from "@udp/config";
import { createPrismaClient } from "@udp/db";
import { decisionSchema, type Decision } from "@udp/shared-types";
import {
  blastEstimate,
  clockOffsetMs,
  decompose,
  DEV_GEOMETRY,
  errorRateBetween,
  PREREGISTRATION,
  preregistrationStatus,
  writeResult,
  type CounterSample,
  type E5Marks,
} from "../src/index.js";

/**
 * **E5** (§14) [v4.8] — MỘT lần đo MTTD/MTTR của auto-rollback nhánh flag-level,
 * theo ĐÚNG `docs/measurements/E5-preregistration.md`. Chạy lại ≥ 10 lần mỗi ô;
 * dựng hạ tầng + rollout: `pnpm --filter @udp/experiments e5-setup`, runbook ở
 * `docs/measurements/kiem-chung-con-no.md` (mục E5).
 *
 *   pnpm --filter @udp/experiments e5 --session <rolloutSessionId> \
 *     --app http://127.0.0.1:3010 --fault "error-rate?p=0.3&scope=flag-on" --cell 5xx
 *
 * TỪ CHỐI chạy nếu file đăng ký trước chưa từng commit hoặc có sửa đổi chưa
 * commit — phép đo gắn với MỘT phiên bản giả thuyết cố định (hash ghi vào kết quả).
 *
 * Mốc: T0 từ timeline sample-app; T_scrape = `lastScrape` của ĐÚNG instance bị bơm
 * (`--scrape-instance`, mặc định suy từ cổng của `--app`), hiệu chỉnh theo độ lệch
 * đồng hồ Prometheus (VM của Docker Desktop) đo ở đầu và cuối lần chạy; T_breach1
 * / T_decision từ `rollout_sessions.last_decision.at` (đồng hồ S3) — đọc session
 * TRƯỚC mọi truy vấn Prometheus trong mỗi vòng poll 1 s; T3 = `cohort-cleared`
 * (chờ theo điều kiện). Sau T_decision tiếp tục bơm lỗi `--post-seconds` và lưu
 * chuỗi bộ đếm để tính tỉ lệ lỗi người dùng trước/sau (đối chứng âm).
 */

const { values } = parseArgs({
  options: {
    session: { type: "string" },
    app: { type: "string", default: "http://127.0.0.1:3010" },
    "scrape-instance": { type: "string" },
    fault: { type: "string", default: "error-rate?p=0.3&scope=flag-on" },
    arm: { type: "string", default: "flag-level" },
    cell: { type: "string", default: "5xx" },
    "post-seconds": { type: "string", default: "60" },
    rps: { type: "string", default: "50" },
    "timeout-minutes": { type: "string", default: "20" },
    note: { type: "string" },
  },
});

/** Hằng của file đăng ký trước (§2): tỉ trọng checkout của tải, tỉ lệ canary */
const CHECKOUT_SHARE = 0.7;
const CANARY_SHARE = 0.2;
/** Lệch đồng hồ giữa đầu và cuối lần chạy lớn hơn chừng này ⇒ lần chạy không hợp lệ */
const MAX_CLOCK_DRIFT_MS = 250;

const status = preregistrationStatus();
if (status.commit === undefined || status.dirty) {
  console.error(
    `${PREREGISTRATION} ${status.commit === undefined ? "chưa từng được commit" : "có sửa đổi chưa commit"} — E5 không chạy khi giả thuyết chưa được đóng băng`,
  );
  process.exit(1);
}
const sessionId: string = values.session ?? "";
if (sessionId === "") {
  console.error("thiếu --session <rolloutSessionId>");
  process.exit(1);
}
const scrapeInstance =
  values["scrape-instance"] ??
  `host.docker.internal:${new URL(values.app).port}`;

const admin = createPrismaClient({
  connectionString: env.DATABASE_URL_DIRECT,
  max: 2,
  cacheKey: `__udp_prisma_e5_${randomUUID()}`,
});

const sleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

async function session() {
  const row = await admin.rolloutSession.findUniqueOrThrow({
    where: { id: sessionId },
    select: {
      status: true,
      lastStepAt: true,
      lastDecision: true,
      metricWindowSeconds: true,
    },
  });
  const parsed = decisionSchema.safeParse(row.lastDecision);
  return { ...row, decision: parsed.success ? parsed.data : undefined };
}

async function prometheus(path: string): Promise<unknown> {
  const res = await fetch(`${env.PROMETHEUS_URL}${path}`);
  if (!res.ok) throw new Error(`Prometheus ${path} → ${String(res.status)}`);
  return res.json();
}

/** Độ lệch đồng hồ Prometheus − máy đo, median của 5 lần hỏi `time()` */
async function clockOffset(): Promise<number> {
  const samples: number[] = [];
  for (let i = 0; i < 5; i += 1) {
    const before = Date.now();
    const body = (await prometheus("/api/v1/query?query=time()")) as {
      data: { result: [number, string] };
    };
    const after = Date.now();
    samples.push(clockOffsetMs(Number(body.data.result[1]), before, after));
  }
  samples.sort((a, b) => a - b);
  return samples[2] ?? 0;
}

async function lastScrape(): Promise<number | undefined> {
  const body = (await prometheus("/api/v1/targets")) as {
    data: {
      activeTargets: { labels: Record<string, string>; lastScrape: string }[];
    };
  };
  const target = body.data.activeTargets.find(
    (t) =>
      t.labels["job"] === "sample-app" &&
      t.labels["instance"] === scrapeInstance,
  );
  return target === undefined ? undefined : Date.parse(target.lastScrape);
}

interface Timeline {
  events: { type: string; at: number; blast?: unknown }[];
  blastRadius: { servedAll: number; failedAll: number };
}

async function app(path: string, method = "GET"): Promise<unknown> {
  const res = await fetch(`${values.app}${path}`, { method });
  if (!res.ok) throw new Error(`${method} ${path} → ${String(res.status)}`);
  return res.json();
}

try {
  // Chờ canary ổn định: sau bậc cuối + window + độ trễ scrape + 30 s (đăng ký trước)
  const start = await session();
  if (start.status !== "IN_PROGRESS" || start.lastStepAt === null) {
    throw new Error(
      `session không ở IN_PROGRESS có bậc (status ${start.status})`,
    );
  }
  const settleAt =
    start.lastStepAt.getTime() +
    (start.metricWindowSeconds +
      METRICS_PROVIDER.defaultScrapeLagSeconds +
      30) *
      1000;
  if (Date.now() < settleAt) await sleep(settleAt - Date.now());

  const offsetStart = await clockOffset();
  await app("/chaos/session", "POST");
  await app(`/chaos/${values.fault}`, "POST");
  const first = (await app("/chaos/timeline")) as Timeline;
  const marks: E5Marks = {
    t0: first.events.find((e) => e.type === "fault-on")?.at ?? Date.now(),
  };

  const deadline = Date.now() + Number(values["timeout-minutes"]) * 60_000;
  const postMs = Number(values["post-seconds"]) * 1000;
  const ticks: Decision[] = [];
  const counters: CounterSample[] = [];
  let finalStatus = "";
  let lastSeenAt = 0;
  let rawScrape: number | undefined;
  while (Date.now() < deadline) {
    await sleep(1_000);
    // Session TRƯỚC: T_decision không bị trễ thêm bởi các truy vấn Prometheus
    const s = await session();
    const d = s.decision;
    if (d !== undefined && d.at > lastSeenAt && d.at >= marks.t0) {
      lastSeenAt = d.at;
      ticks.push(d);
      if (d.breach) marks.tBreach1 ??= d.at;
      if (d.decision === "ROLLBACK") marks.tDecision = d.at;
    }
    finalStatus = s.status;
    const timeline = (await app("/chaos/timeline")) as Timeline;
    counters.push({ at: Date.now(), ...timeline.blastRadius });
    marks.t3 ??= timeline.events.find((e) => e.type === "cohort-cleared")?.at;
    if (rawScrape === undefined) {
      const scrape = await lastScrape();
      if (scrape !== undefined && scrape - offsetStart > marks.t0) {
        rawScrape = scrape;
      }
    }
    const closed = s.status !== "IN_PROGRESS" && s.status !== "PAUSED";
    // Đóng rồi: chờ đủ cửa sổ sau T_decision VÀ đã có T3 (hoặc hết cửa sổ)
    if (closed && Date.now() >= (marks.tDecision ?? Date.now()) + postMs) break;
  }
  const final = (await app("/chaos/timeline")) as Timeline;
  await app("/chaos/reset", "POST");
  const offsetEnd = await clockOffset();
  const offset = (offsetStart + offsetEnd) / 2;
  if (rawScrape !== undefined) marks.tScrape = rawScrape - offset;

  const breakdown = decompose(marks);
  const decisionAt = marks.tDecision;
  const negativeControl =
    decisionAt === undefined
      ? undefined
      : {
          errorRateBefore: errorRateBetween(
            counters,
            decisionAt - postMs,
            decisionAt,
          ),
          errorRateAfter: errorRateBetween(
            counters,
            decisionAt,
            decisionAt + postMs,
          ),
        };
  const cleared = final.events.find((e) => e.type === "cohort-cleared");
  const result = {
    preregistrationCommit: status.commit,
    arm: values.arm,
    cell: values.cell,
    fault: values.fault,
    sessionId,
    scrapeInstance,
    finalStatus,
    clock: {
      offsetStartMs: offsetStart,
      offsetEndMs: offsetEnd,
      stable: Math.abs(offsetEnd - offsetStart) <= MAX_CLOCK_DRIFT_MS,
    },
    marks,
    breakdown,
    blastRadiusAtT3: cleared?.blast,
    blastEstimate: blastEstimate(
      breakdown,
      Number(values.rps),
      CHECKOUT_SHARE,
      CANARY_SHARE,
    ),
    negativeControl,
    ticks,
    counters,
    timeline: final.events,
  };
  console.log(
    JSON.stringify({ marks, breakdown, negativeControl, clock: result.clock }),
  );
  const file = writeResult("E5", DEV_GEOMETRY, result, values.note);
  console.log(`Đã ghi ${file}`);
} finally {
  await admin.$disconnect();
}
