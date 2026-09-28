import { execFile } from "node:child_process";
import { get, type ClientRequest } from "node:http";
import { parseArgs, promisify } from "node:util";
import { RATE_LIMIT, SSE } from "@udp/config/constants";
import { SEED_DEV_SERVER_KEY } from "@udp/db/seed-constants";
import { HOST_PORTS, KUBE_CONTEXT } from "@udp/deploy/cluster";
import {
  parseSummary,
  perStreamKiB,
  retryAfterMs,
  usageOf,
  type ContainerSample,
  type Usage,
} from "../src/e9.js";
import { writeResult } from "../src/results.js";

/**
 * **E9** (§14.1) [Plan #50] — CPU/RAM của ba service khi RỖI và khi **1 000 SDK nối SSE**, trên cụm kind do
 * `pnpm deploy:up` dựng (job `kind` của CI, làn đêm):
 *
 *   pnpm --filter @udp/experiments e9 [--streams 1000] [--settle 60] [--duration 180] [--interval 15]
 *
 * Nguồn số: Summary API của kubelet qua `kubectl get --raw` (xem `src/e9.ts`). Tải: stream `/sdk/stream` THẬT
 * bằng SERVER key của seed, qua NodePort — trần mở 1 000/phút và 1 000 stream/khoá của Service 2 đặt đúng
 * cho phép đo này; 429 ⇒ chờ `Retry-After` rồi mở lại. Không đủ số stream ⇒ thoát mã 1 và KHÔNG ghi kết quả:
 * một phép đo thiếu tải không được ghi như số của E9. Nhánh "100 rollout đồng thời" và hai pha ADR-05 không
 * đo ở đây. Sổ nợ: `E9`
 *
 * Chỉ import hằng thuần: harness chạy trong runner không có `.env`.
 */

/** "1 000 SDK kết nối SSE" của §14.1 */
const E9_STREAMS = 1000;

const { values } = parseArgs({
  options: {
    streams: { type: "string", default: String(E9_STREAMS) },
    settle: { type: "string", default: "60" },
    duration: { type: "string", default: "180" },
    interval: { type: "string", default: "15" },
    note: { type: "string" },
  },
});
const streamsTarget = Number(values.streams);
const settleS = Number(values.settle);
const durationS = Number(values.duration);
const intervalS = Number(values.interval);
if (
  ![streamsTarget, settleS, durationS, intervalS].every(
    (n) => Number.isInteger(n) && n > 0,
  )
) {
  throw new Error(
    "--streams, --settle, --duration, --interval phải là số nguyên dương",
  );
}
if (streamsTarget > RATE_LIMIT.sdk.maxStreamsPerKey) {
  throw new Error(
    `--streams ${String(streamsTarget)} vượt trần ${String(RATE_LIMIT.sdk.maxStreamsPerKey)} stream/khoá của Service 2`,
  );
}

const run = promisify(execFile);
const sleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));
/** Namespace của UDP (`udp`) và của workload env (`udp-<project>-…`, gồm sample-app) */
const ours = (ns: string): boolean => ns === "udp" || ns.startsWith("udp-");

async function kubectl(args: string[]): Promise<string> {
  const { stdout } = await run(
    "kubectl",
    ["--context", KUBE_CONTEXT, ...args],
    {
      maxBuffer: 64 * 1024 * 1024,
    },
  );
  return stdout;
}

const node = (
  await kubectl(["get", "nodes", "-o", "jsonpath={.items[0].metadata.name}"])
).trim();

async function samplePhase(label: string): Promise<Usage[]> {
  const ticks: ContainerSample[][] = [];
  const end = Date.now() + durationS * 1000;
  while (Date.now() < end) {
    const raw = await kubectl([
      "get",
      "--raw",
      `/api/v1/nodes/${node}/proxy/stats/summary`,
    ]);
    ticks.push(parseSummary(raw, ours));
    await sleep(intervalS * 1000);
  }
  console.log(`${label}: ${String(ticks.length)} lượt hỏi kubelet`);
  return usageOf(ticks);
}

// ------------------------------------------------------------- tải SSE

interface Stream {
  request?: ClientRequest;
  accepted: boolean;
  snapshot: boolean;
  lastByteAt: number;
}

const counters = { rejected429: 0, errors: 0, reconnects: 0 };
/** Đang dọn cuối phép đo: stream đóng lúc này là do harness, không mở lại, không đếm lỗi */
let closing = false;

function reopenLater(stream: Stream, ms: number): void {
  stream.accepted = false;
  if (!closing) setTimeout(() => open(stream), ms);
}

function open(stream: Stream): void {
  const request = get(
    `http://127.0.0.1:${String(HOST_PORTS.flagService)}/sdk/stream`,
    {
      headers: {
        Authorization: `Bearer ${SEED_DEV_SERVER_KEY}`,
        Accept: "text/event-stream",
      },
    },
    (res) => {
      if (res.statusCode !== 200) {
        if (res.statusCode === 429) counters.rejected429 += 1;
        else counters.errors += 1;
        // Đọc hết body problem+json để socket về pool, rồi mở lại sau Retry-After — như SDK làm
        const wait = retryAfterMs(res.headers["retry-after"], 5);
        res.resume();
        res.on("end", () => reopenLater(stream, wait));
        return;
      }
      stream.accepted = true;
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => {
        stream.lastByteAt = Date.now();
        if (chunk.includes("event: snapshot")) stream.snapshot = true;
      });
      // Server đóng stream giữa pha (tắt replica, thu hồi khoá) ⇒ SDK nối lại; đếm để người đọc biết
      res.on("end", () => {
        if (closing) return;
        counters.reconnects += 1;
        reopenLater(stream, 1_000);
      });
      res.on("error", () => undefined);
    },
  );
  request.on("error", () => {
    if (closing || stream.request !== request) return;
    counters.errors += 1;
    reopenLater(stream, 1_000);
  });
  stream.request = request;
}

const idle = await (async () => {
  console.log(`rỗi: chờ ${String(settleS)} s cho cụm lắng`);
  await sleep(settleS * 1000);
  return samplePhase("rỗi");
})();

const streams: Stream[] = Array.from({ length: streamsTarget }, () => ({
  accepted: false,
  snapshot: false,
  lastByteAt: 0,
}));
const openedAt = Date.now();
// 50 stream mỗi 0,5 s: 1 000 stream trong ~10 s — dưới trần mở 1 000/phút, không dồn một khối vào hub
for (let i = 0; i < streams.length; i += 50) {
  for (const s of streams.slice(i, i + 50)) open(s);
  await sleep(500);
}
const openDeadline = Date.now() + 180_000;
while (streams.some((s) => !s.snapshot) && Date.now() < openDeadline) {
  await sleep(1_000);
}
const snapshots = streams.filter((s) => s.snapshot).length;
const openSeconds = Math.round((Date.now() - openedAt) / 100) / 10;
console.log(
  `SSE: ${String(snapshots)}/${String(streamsTarget)} stream nhận snapshot sau ${String(openSeconds)} s`,
);

let loaded: Usage[] = [];
let aliveAtEnd = 0;
try {
  if (snapshots < streamsTarget) {
    throw new Error(
      `chỉ ${String(snapshots)}/${String(streamsTarget)} stream mở được (429: ${String(counters.rejected429)}, lỗi: ${String(counters.errors)}) — không ghi kết quả`,
    );
  }
  loaded = await samplePhase(`${String(streamsTarget)} SSE`);
  // Nhịp tim mỗi 20 s: stream nào im quá hai nhịp là đã chết trong pha đo
  const aliveWindow = 2 * SSE.heartbeatMs;
  aliveAtEnd = streams.filter(
    (s) => Date.now() - s.lastByteAt <= aliveWindow,
  ).length;
} finally {
  closing = true;
  for (const s of streams) s.request?.destroy();
}

const data = {
  node,
  params: {
    streams: streamsTarget,
    settleSeconds: settleS,
    durationSeconds: durationS,
    intervalSeconds: intervalS,
  },
  streams: {
    snapshots,
    aliveAtEnd,
    openSeconds,
    rejected429: counters.rejected429,
    errors: counters.errors,
    reconnects: counters.reconnects,
  },
  phases: { idle, sse: loaded },
  derived: {
    flagServiceKiBPerStream: perStreamKiB(
      idle,
      loaded,
      "flag-service",
      streamsTarget,
    ),
  },
};

for (const [phase, rows] of Object.entries(data.phases)) {
  for (const u of rows) {
    console.log(
      `${phase.padEnd(4)} ${`${u.namespace}/${u.container}`.padEnd(48)} CPU tb ${String(u.cpuMillicoresMean)} m, max ${String(u.cpuMillicoresMax)} m; RAM p50 ${String(u.memoryMiBP50)} MiB, max ${String(u.memoryMiBMax)} MiB`,
    );
  }
}
console.log(
  `Service 2: ${String(data.derived.flagServiceKiBPerStream)} KiB mỗi stream; còn sống cuối pha ${String(aliveAtEnd)}/${String(streamsTarget)}`,
);
console.log(
  `đã ghi ${writeResult("E9", `kind một node (${node}) trên máy chạy harness; tải từ cùng máy qua NodePort`, data, values.note)}`,
);
process.exit(0);
