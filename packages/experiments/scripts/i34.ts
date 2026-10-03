import { randomUUID } from "node:crypto";
import { createServer, connect, type Server, type Socket } from "node:net";
import { parseArgs } from "node:util";
import {
  OpenFeature,
  ProviderEvents,
  type EvaluationDetails,
} from "@openfeature/server-sdk";
import { env, PROVIDER, SSE } from "@udp/config";
import { createPrismaClient } from "@udp/db";
import { UDPFeatureFlagProvider } from "@udp/openfeature-provider";
import {
  createActiveFlag,
  createScratchProject,
  internalCall,
  issueSdkKey,
} from "@udp/test-support/fixture";
import { freePort } from "@udp/test-support/net";
import {
  startFlagService,
  type RunningService,
} from "@udp/test-support/service";
import request from "supertest";
import { DEV_GEOMETRY, round, writeResult } from "../src/index.js";

/**
 * **I34** (§13.3) [v4.8] — fail-static giữ ĐÚNG giá trị cuối trong 5 phút mất kết
 * nối giữa lúc có traffic, và hội tụ về thay đổi đã LỠ khi thông lại.
 *
 *   pnpm --filter @udp/experiments i34 [--outage 300]
 *
 * Hai chế độ ngắt, mỗi chế độ `--outage` giây:
 *   - HỐ ĐEN: proxy TCP giữa provider và Service 2 giữ kết nối nhưng nuốt mọi byte
 *     — kết nối nửa mở, không lỗi nào tự báo (watchdog nhịp tim phải bắt);
 *   - CHẾT: Service 2 phục vụ provider dừng hẳn.
 * Giữa lúc ngắt, một thay đổi được ghi qua Service 2 THỨ HAI (không qua proxy) —
 * provider không thể thấy nó cho tới khi thông lại. Vòng đánh giá 20 lần/giây suốt
 * thời gian đo. Khẳng định: mọi lần đánh giá trong lúc ngắt trả giá trị CUỐI (không
 * lỗi, không default), `stale` bật sau `staleAfterSeconds` (120), sau khi thông lại
 * hội tụ về thay đổi đã lỡ — báo thời gian thật so với ngưỡng
 * `pollingInterval + heartbeatTimeout`.
 */

const { values } = parseArgs({
  options: { outage: { type: "string", default: "300" } },
});
const OUTAGE_MS = Number(values.outage) * 1000;
const STALE_AFTER_SECONDS = 120;
const EVALUATE_EVERY_MS = 50;
const CONVERGE_LIMIT_MS =
  SSE.pollingFallbackMs + SSE.heartbeatMs * PROVIDER.heartbeatTimeoutFactor;
/**
 * Cửa sổ `stale` hợp lệ, tính từ lúc ngắt. Đồng hồ "còn tươi" của provider được
 * làm mới mỗi nhịp tim (`SSE.heartbeatMs`), nên lúc ngắt nó đã già 0 … heartbeatMs
 * ⇒ STALE bật sớm nhất `staleAfter − heartbeat`; muộn nhất `staleAfter` cộng một
 * chu kỳ kiểm (≤ 1 s) và nhịp lấy mẫu. Đòi `≥ staleAfter` là đòi sai: lần đo đầu
 * (STALE ở 110,5 s) bị đánh trượt vì đúng điều này.
 */
const STALE_MIN_SECONDS = STALE_AFTER_SECONDS - SSE.heartbeatMs / 1000;
const STALE_MAX_SECONDS = STALE_AFTER_SECONDS + 2;

/**
 * Proxy TCP giả lập mạng: `pass` chuyển tiếp; `blackhole` NUỐT byte mà giữ kết nối
 * (kết nối nửa mở — không lỗi nào tự báo). Mỗi kết nối nhớ nó có bị hố đen chưa:
 * mạng thông lại KHÔNG cứu các kết nối đã nửa mở (TCP ngoài đời không tự đóng
 * chúng) — provider phải tự nhận ra bằng watchdog nhịp tim; chỉ kết nối MỚI thông.
 */
class ChaosProxy {
  private mode: "pass" | "blackhole" = "pass";
  private readonly connections = new Set<{
    client: Socket;
    upstream: Socket | undefined;
    dead: boolean;
  }>();
  private server: Server | undefined;

  constructor(private readonly targetPort: number) {}

  async listen(port: number): Promise<void> {
    this.server = createServer((client) => {
      const conn = {
        client,
        upstream: undefined as Socket | undefined,
        dead: this.mode === "blackhole",
      };
      this.connections.add(conn);
      client.on("error", () => client.destroy());
      client.on("close", () => {
        conn.upstream?.destroy();
        this.connections.delete(conn);
      });
      if (conn.dead) {
        client.on("data", () => undefined); // nhận rồi bỏ
        return;
      }
      const upstream = connect(this.targetPort, "127.0.0.1");
      conn.upstream = upstream;
      upstream.on("error", () => upstream.destroy());
      upstream.on("close", () => {
        if (!conn.dead) client.destroy();
      });
      client.on("data", (d) => {
        if (!conn.dead) upstream.write(d);
      });
      upstream.on("data", (d) => {
        if (!conn.dead) client.write(d);
      });
    });
    await new Promise<void>((r) => this.server?.listen(port, "127.0.0.1", r));
  }

  /** Mọi kết nối đang có và kết nối mới đều thành hố đen */
  blackhole(): void {
    this.mode = "blackhole";
    for (const conn of this.connections) conn.dead = true;
  }

  /** Kết nối MỚI thông lại; kết nối nửa mở cũ vẫn nuốt byte */
  restore(): void {
    this.mode = "pass";
  }

  async close(): Promise<void> {
    for (const conn of this.connections) {
      conn.client.destroy();
      conn.upstream?.destroy();
    }
    await new Promise((r) => this.server?.close(r));
  }
}

interface Sample {
  at: number;
  value: boolean;
  reason: string | undefined;
  stale: boolean;
  error: string | undefined;
}

const admin = createPrismaClient({
  connectionString: env.DATABASE_URL_DIRECT,
  max: 2,
  cacheKey: `__udp_prisma_i34_${randomUUID()}`,
});
const scratch = await createScratchProject(admin, "exp-i34");
let served: RunningService | undefined;
let writer: RunningService | undefined;
let proxy: ChaosProxy | undefined;
let evaluator: ReturnType<typeof setInterval> | undefined;

const phases: Record<string, unknown>[] = [];
try {
  const servedPort = await freePort();
  served = await startFlagService({ port: servedPort });
  writer = await startFlagService();
  const proxyPort = await freePort();
  proxy = new ChaosProxy(servedPort);
  await proxy.listen(proxyPort);
  const writerUrl = writer.baseUrl;
  const servedService = served;
  const chaos = proxy;
  const owner = { id: scratch.ownerId };
  const envId = scratch.environmentId;
  const flag = await createActiveFlag(writerUrl, owner.id, {
    projectId: scratch.projectId,
    key: "f0",
    flagType: "BOOLEAN",
  });
  const { id: configId } = await admin.flagEnvConfig.findFirstOrThrow({
    where: { flagId: flag.body.flag.id as string, environmentId: envId },
    select: { id: true },
  });
  const setEnabled = async (isEnabled: boolean): Promise<void> => {
    await internalCall(
      request(writerUrl).patch(`/internal/flag-envs/${configId}`),
      owner.id,
    )
      .send({ isEnabled })
      .expect(200);
  };
  await setEnabled(true);
  const serverKey = await issueSdkKey(admin, {
    environmentId: envId,
    keyType: "SERVER",
    createdById: owner.id,
  });

  await OpenFeature.setProviderAndWait(
    "i34",
    new UDPFeatureFlagProvider({
      host: `http://127.0.0.1:${String(proxyPort)}`,
      sdkKey: serverKey,
      staleAfterSeconds: STALE_AFTER_SECONDS,
      // Ghim TẮT: I34 đo fail-static qua một proxy hố-đen; một `POST /sdk/stats`
      // treo trong đó chỉ thêm nhiễu vào mốc thời gian đang đo
      reportStats: false,
    }),
  );
  const client = OpenFeature.getClient("i34");
  const events: { at: number; event: string }[] = [];
  for (const [event, name] of [
    [ProviderEvents.Ready, "READY"],
    [ProviderEvents.Stale, "STALE"],
    [ProviderEvents.Error, "ERROR"],
    [ProviderEvents.ConfigurationChanged, "CONFIGURATION_CHANGED"],
  ] as const) {
    client.addHandler(event, () =>
      events.push({ at: Date.now(), event: name }),
    );
  }

  const samples: Sample[] = [];
  evaluator = setInterval(() => {
    const at = Date.now();
    client
      .getBooleanDetails("f0", false, { targetingKey: `u-${String(at % 997)}` })
      .then((d: EvaluationDetails<boolean>) =>
        samples.push({
          at,
          value: d.value,
          reason: d.reason,
          stale: d.flagMetadata["stale"] === true,
          error: d.errorCode,
        }),
      )
      .catch((err: unknown) =>
        samples.push({
          at,
          value: false,
          reason: undefined,
          stale: false,
          error: String(err),
        }),
      );
  }, EVALUATE_EVERY_MS);

  /**
   * Một pha: ngắt → sau 1/5 thời gian ghi thay đổi qua writer → hết giờ thông lại →
   * chờ hội tụ (lý do đánh giá phản ánh thay đổi)
   */
  const phase = async (
    name: string,
    cut: () => Promise<void>,
    heal: () => Promise<void>,
    enableTo: boolean,
  ) => {
    await new Promise((r) => setTimeout(r, 10_000));
    const before = samples.at(-1);
    if (before === undefined || before.error !== undefined) {
      throw new Error(`${name}: chưa có đánh giá khoẻ trước khi ngắt`);
    }
    const start = Date.now();
    await cut();
    await new Promise((r) => setTimeout(r, OUTAGE_MS / 5));
    await setEnabled(enableTo);
    await new Promise((r) => setTimeout(r, OUTAGE_MS - OUTAGE_MS / 5));
    const healedAt = Date.now();
    await heal();
    // Hội tụ = đánh giá KHOẺ phản ánh thay đổi — lần đánh giá lỗi không tính
    const converged = (s: Sample): boolean =>
      s.error === undefined &&
      (enableTo ? s.reason !== "DISABLED" : s.reason === "DISABLED");
    const deadline = healedAt + CONVERGE_LIMIT_MS * 2;
    while (
      Date.now() < deadline &&
      !samples.some((s) => s.at >= healedAt && converged(s))
    ) {
      await new Promise((r) => setTimeout(r, 200));
    }
    const during = samples.filter((s) => s.at >= start && s.at < healedAt);
    const wrong = during.filter(
      (s) =>
        s.error !== undefined ||
        s.value !== before.value ||
        s.reason !== before.reason,
    );
    const firstStale = during.find((s) => s.stale);
    const convergedAt = samples.find(
      (s) => s.at >= healedAt && converged(s),
    )?.at;
    const staleSeconds =
      firstStale === undefined ? undefined : (firstStale.at - start) / 1000;
    const convergedSeconds =
      convergedAt === undefined ? undefined : (convergedAt - healedAt) / 1000;
    const result = {
      phase: name,
      /**
       * Đạt ⇔ không một lần đánh giá sai/lỗi trong lúc ngắt, `stale` bật trong
       * [STALE_MIN_SECONDS, STALE_MAX_SECONDS], và hội tụ trong ngưỡng
       */
      pass:
        wrong.length === 0 &&
        staleSeconds !== undefined &&
        staleSeconds >= STALE_MIN_SECONDS &&
        staleSeconds <= STALE_MAX_SECONDS &&
        convergedSeconds !== undefined &&
        convergedSeconds * 1000 <= CONVERGE_LIMIT_MS,
      outageSeconds: OUTAGE_MS / 1000,
      evaluationsDuringOutage: during.length,
      wrongOrErrorDuringOutage: wrong.length,
      staleAfterSeconds:
        staleSeconds === undefined ? undefined : round(staleSeconds, 1),
      convergedAfterRestoreSeconds:
        convergedSeconds === undefined ? undefined : round(convergedSeconds, 1),
      convergeLimitSeconds: CONVERGE_LIMIT_MS / 1000,
      events: events
        .filter((e) => e.at >= start)
        .map((e) => ({ t: round((e.at - start) / 1000, 1), event: e.event })),
    };
    console.log(JSON.stringify(result));
    phases.push(result);
  };

  await phase(
    "hố đen (proxy giữ kết nối, nuốt byte)",
    () => {
      chaos.blackhole();
      return Promise.resolve();
    },
    () => {
      chaos.restore();
      return Promise.resolve();
    },
    false,
  );
  await phase(
    "Service 2 chết",
    () => servedService.stop(),
    () => servedService.start(),
    true,
  );
} finally {
  if (evaluator !== undefined) clearInterval(evaluator);
  await OpenFeature.close();
  await proxy?.close();
  await served?.stop();
  await writer?.stop();
  await scratch.dispose();
  await admin.$disconnect();
}

const file = writeResult("I34", DEV_GEOMETRY, {
  method: {
    evaluateEveryMs: EVALUATE_EVERY_MS,
    staleAfterSeconds: STALE_AFTER_SECONDS,
    staleWindowSeconds: [STALE_MIN_SECONDS, STALE_MAX_SECONDS],
    change:
      "ghi qua Service 2 thứ hai (không qua proxy) sau 1/5 thời gian ngắt",
    wrong: "lỗi, hoặc value/reason khác lần đánh giá khoẻ cuối trước khi ngắt",
  },
  phases,
  pass: phases.every((p) => p["pass"] === true),
});
console.log(`Đã ghi ${file}`);
// Kết luận trượt ⇒ mã thoát khác 0 để chuỗi đo / CI dừng lại, không âm thầm "xong"
if (!phases.every((p) => p["pass"] === true)) process.exitCode = 1;
