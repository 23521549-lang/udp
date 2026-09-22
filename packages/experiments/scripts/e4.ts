import { randomUUID } from "node:crypto";
import { parseArgs } from "node:util";
import { OpenFeature, ProviderEvents } from "@openfeature/server-sdk";
import { env } from "@udp/config";
import { createPrismaClient } from "@udp/db";
import { UDPFeatureFlagProvider } from "@udp/openfeature-provider";
import {
  createActiveFlag,
  createScratchProject,
  internalCall,
  issueSdkKey,
  type ScratchProject,
} from "@udp/test-support/fixture";
import { startFlagService } from "@udp/test-support/service";
import request from "supertest";
import {
  counterValue,
  DEV_GEOMETRY,
  round,
  scrape,
  summarize,
  writeResult,
} from "../src/index.js";

/**
 * **E4** (§14) [v4.8] — độ trễ lan truyền cấu hình, băng thông và số truy vấn mỗi
 * lần thay đổi, qua bốn ô `CHANGEFEED_MODE` × NOTIFY, và trục KÍCH THƯỚC env
 * (1/10/100 flag) — nơi delta bắt đầu đáng giá.
 *
 *   pnpm --filter @udp/experiments e4 [--runs 100 --baseline 120 --sizes 1,10,100]
 *
 * Mỗi ô: Service 2 tiến trình con với đúng cấu hình ô, MỘT provider thật (HTTP +
 * SSE). Mỗi lần: `PATCH /internal/flag-envs/:id` bật/tắt flag `f0` — t0 lúc gửi,
 * t1 lúc nhận trả lời (đã commit), t2 lúc provider phát CONFIGURATION_CHANGED chứa
 * `f0`. Điểm đầu là lần ghi vào Service 2 (Service 1 chỉ thêm một bước HTTP nội
 * bộ; Portal chưa có). Giữa hai lần chờ U(0, 1 s) — không lệch pha với chu kỳ poll
 * 500–700 ms của tầng không NOTIFY. Một lần hết giờ (15 s) được GHI là lần hỏng
 * của ô và phép đo đi tiếp — không mất cả lượt chạy.
 *
 * Truy vấn/lần = delta `udp_flag_db_queries_total` trong [t0, t2 + 300 ms] TRỪ tốc
 * độ nền × độ dài cửa sổ; tốc độ nền đo trong cửa sổ rỗi `--baseline` giây ngay
 * trước ô (provider đã nối). Đếm sự kiện truy vấn của client Prisma (COMMIT có,
 * BEGIN không phát); kênh LISTEN của NOTIFY là kết nối `pg` riêng — KHÔNG đếm.
 * Byte/lần = delta `udp_flag_sse_bytes_total` của khối `snapshot`/`flag_changed`
 * (phía server) và byte provider nhận (phía SDK).
 *
 * Số đo trên máy dev tới database ở Singapore là DEV-GEOMETRY: RTT database chiếm
 * phần lớn; hình học CI (cùng vùng với database) — sổ nợ.
 */

const { values } = parseArgs({
  options: {
    runs: { type: "string", default: "100" },
    baseline: { type: "string", default: "120" },
    sizes: { type: "string", default: "1,10,100" },
    note: { type: "string" },
  },
});
const RUNS = Number(values.runs);
const BASELINE_SECONDS = Number(values.baseline);
const SIZES = values.sizes.split(",").map(Number);
const SETTLE_MS = 300;
const EVENT_TIMEOUT_MS = 15_000;

const admin = createPrismaClient({
  connectionString: env.DATABASE_URL_DIRECT,
  max: 2,
  cacheKey: `__udp_prisma_e4_${randomUUID()}`,
});

interface Fixture {
  size: number;
  project: ScratchProject;
  configId: string;
  serverKey: string;
}

const queriesOf = async (base: string): Promise<number> =>
  counterValue(await scrape(base), "udp_flag_db_queries_total");

async function sseBytesOf(base: string): Promise<number> {
  const text = await scrape(base);
  return (
    counterValue(text, "udp_flag_sse_bytes_total", '{event="snapshot"}') +
    counterValue(text, "udp_flag_sse_bytes_total", '{event="flag_changed"}')
  );
}

/** `fetch` đếm byte body mà provider nhận (phía SDK) */
function countingFetch(counter: { bytes: number }): typeof fetch {
  return async (input, init) => {
    const res = await fetch(input, init);
    if (res.body === null) return res;
    const counted = res.body.pipeThrough(
      new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          counter.bytes += chunk.byteLength;
          controller.enqueue(chunk);
        },
      }),
    );
    return new Response(counted, {
      status: res.status,
      statusText: res.statusText,
      headers: res.headers,
    });
  };
}

/** Dựng env mỗi kích thước — mỗi project vào `made` NGAY khi tạo để luôn được dọn */
async function fixtures(made: Fixture[]): Promise<void> {
  const s2 = await startFlagService();
  try {
    for (const size of SIZES) {
      const project = await createScratchProject(
        admin,
        `exp-e4-${String(size)}`,
      );
      const fixture: Fixture = { size, project, configId: "", serverKey: "" };
      made.push(fixture);
      let firstFlagId = "";
      for (let f = 0; f < size; f += 1) {
        const created = await createActiveFlag(s2.baseUrl, project.ownerId, {
          projectId: project.projectId,
          key: `f${String(f)}`,
          flagType: "BOOLEAN",
        });
        if (f === 0) firstFlagId = created.body.flag.id as string;
      }
      const config = await admin.flagEnvConfig.findFirstOrThrow({
        where: { flagId: firstFlagId, environmentId: project.environmentId },
        select: { id: true },
      });
      fixture.configId = config.id;
      fixture.serverKey = await issueSdkKey(admin, {
        environmentId: project.environmentId,
        keyType: "SERVER",
        createdById: project.ownerId,
      });
      console.log(`dựng env ${String(size)} flag`);
    }
  } finally {
    await s2.stop();
  }
}

async function cell(
  fixture: Fixture,
  mode: "snapshot" | "delta",
  notify: boolean,
) {
  const s2 = await startFlagService({
    env: { CHANGEFEED_MODE: mode, CHANGEFEED_NOTIFY_ENABLED: String(notify) },
  });
  const received = { bytes: 0 };
  const domain = `e4-${String(fixture.size)}-${mode}-${String(notify)}`;
  try {
    await OpenFeature.setProviderAndWait(
      domain,
      new UDPFeatureFlagProvider({
        host: s2.baseUrl,
        sdkKey: fixture.serverKey,
        fetch: countingFetch(received),
      }),
    );
    const client = OpenFeature.getClient(domain);
    let waiter: ((at: number) => void) | undefined;
    client.addHandler(ProviderEvents.ConfigurationChanged, (details) => {
      const changed: unknown = details?.flagsChanged;
      if (Array.isArray(changed) && changed.includes("f0"))
        waiter?.(performance.now());
    });

    // Nền rỗi: tốc độ truy vấn khi không có thay đổi nào (poll, nhịp tim, kiểm khoá)
    const q0 = await queriesOf(s2.baseUrl);
    const b0 = performance.now();
    await new Promise((r) => setTimeout(r, BASELINE_SECONDS * 1000));
    const idlePerMs =
      ((await queriesOf(s2.baseUrl)) - q0) / (performance.now() - b0);

    const total: number[] = [];
    const afterCommit: number[] = [];
    const queries: number[] = [];
    const serverBytes: number[] = [];
    const clientBytes: number[] = [];
    let timeouts = 0;
    // Trạng thái THẬT trước vòng đo: PATCH giữ nguyên giá trị không đổi gì, không
    // có sự kiện nào để chờ
    let { isEnabled: enabled } = await admin.flagEnvConfig.findUniqueOrThrow({
      where: { id: fixture.configId },
      select: { isEnabled: true },
    });
    for (let run = 0; run < RUNS; run += 1) {
      await new Promise((r) => setTimeout(r, Math.random() * 1000));
      enabled = !enabled;
      const qBefore = await queriesOf(s2.baseUrl);
      const sBefore = await sseBytesOf(s2.baseUrl);
      const cBefore = received.bytes;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const arrived = new Promise<number | undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), EVENT_TIMEOUT_MS);
        waiter = resolve;
      });
      const t0 = performance.now();
      await internalCall(
        request(s2.baseUrl).patch(`/internal/flag-envs/${fixture.configId}`),
        fixture.project.ownerId,
      )
        .send({ isEnabled: enabled })
        .expect(200);
      const t1 = performance.now();
      const t2 = await arrived;
      clearTimeout(timer);
      waiter = undefined;
      if (t2 === undefined) {
        timeouts += 1;
        continue;
      }
      await new Promise((r) => setTimeout(r, SETTLE_MS));
      const windowMs = performance.now() - t0;
      total.push(t2 - t0);
      afterCommit.push(t2 - t1);
      queries.push(
        (await queriesOf(s2.baseUrl)) - qBefore - idlePerMs * windowMs,
      );
      serverBytes.push((await sseBytesOf(s2.baseUrl)) - sBefore);
      clientBytes.push(received.bytes - cBefore);
    }
    const ms = (xs: number[]) => {
      const s = summarize(xs);
      return {
        p50: round(s.p50, 1),
        p90: round(s.p90, 1),
        p99: round(s.p99, 1),
        max: round(s.max, 1),
      };
    };
    const med = (xs: number[]) => round(summarize(xs).p50, 1);
    const result = {
      flags: fixture.size,
      mode,
      notify,
      runs: RUNS,
      timeouts,
      latencyMs: ms(total),
      afterCommitMs: ms(afterCommit),
      idleQueriesPerSecond: round(idlePerMs * 1000, 3),
      queriesPerChange: {
        median: med(queries),
        iqr: round(summarize(queries).iqr, 1),
      },
      serverBytesPerChange: { median: med(serverBytes) },
      sdkBytesPerChange: { median: med(clientBytes) },
    };
    console.log(
      `${String(fixture.size).padStart(3)} flag ${mode.padEnd(8)} notify=${String(notify).padEnd(5)} — p50 ${String(result.latencyMs.p50)} ms p99 ${String(result.latencyMs.p99)} ms | ${String(result.queriesPerChange.median)} truy vấn | ${String(result.serverBytesPerChange.median)} B | hết giờ ${String(timeouts)}`,
    );
    return result;
  } finally {
    await OpenFeature.clearProviders();
    await s2.stop();
  }
}

const made: Fixture[] = [];
const cells = [];
try {
  await fixtures(made);
  for (const fixture of made) {
    for (const mode of ["snapshot", "delta"] as const) {
      for (const notify of [true, false]) {
        cells.push(await cell(fixture, mode, notify));
      }
    }
  }
} finally {
  for (const f of made) await f.project.dispose();
  await admin.$disconnect();
}
const file = writeResult(
  "E4",
  DEV_GEOMETRY,
  {
    method: {
      start: "gửi PATCH /internal/flag-envs/:id (S2)",
      end: "provider phát CONFIGURATION_CHANGED chứa f0",
      runsPerCell: RUNS,
      eventTimeoutMs: EVENT_TIMEOUT_MS,
      jitter: "U(0, 1 s) giữa hai lần",
      idleBaselineSeconds: BASELINE_SECONDS,
      queries:
        "delta udp_flag_db_queries_total trong [t0, t2+300ms] trừ tốc độ nền × độ dài cửa sổ (sự kiện Prisma: COMMIT có, BEGIN không; kênh LISTEN không đếm)",
      serverBytes:
        "delta udp_flag_sse_bytes_total{event=snapshot|flag_changed}",
      sdkBytes: "byte body provider nhận qua fetch (SSE + /sdk/config)",
    },
    cells,
  },
  values.note,
);
console.log(`Đã ghi ${file}`);
