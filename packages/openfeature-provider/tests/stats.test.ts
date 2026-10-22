import { execFile } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { SDK_STATS } from "@udp/config/constants";
import type { Evaluation, SdkStatsReport } from "@udp/shared-types";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type {
  UDPFeatureFlagProvider,
  UDPProviderOptions,
} from "../src/index.js";
import {
  StatsCounter,
  StatsReporter,
  type StatsOptions,
} from "../src/stats.js";
import {
  configBody,
  createProviderForTesting,
  flag,
  InMemoryTransport,
  ScriptedStream,
} from "../src/testing.js";
import { waitFor } from "./helpers/wait.js";

/**
 * `reportStats` của provider (§6.8, V7/V8) [v4.9] — bộ đếm trên đường nóng, đồng
 * hồ 60 giây và luật phân loại phản hồi. Mọi ca dùng transport giả: không mạng,
 * không đồng hồ thật nào dài hơn vài chục mili-giây.
 *
 * Trọng tâm là R19: telemetry không được làm hỏng đánh giá (I33), không giữ tiến
 * trình của khách sống, không chặn `close()`, và KHÔNG BAO GIỜ đếm đôi.
 */

const INTERVAL_MS = 25;

function providerWith(
  transport: InMemoryTransport,
  options: Partial<UDPProviderOptions> = {},
  stats: Partial<StatsOptions> = {},
): UDPFeatureFlagProvider {
  return createProviderForTesting(
    { host: "http://unused", sdkKey: "k", initTimeoutMs: 2_000, ...options },
    {
      transport,
      sync: {
        pollingIntervalMs: 50,
        backoffMinMs: 5,
        staleCheckMs: 10,
        random: () => 0.5,
      },
      // `random: () => 0.5` ⇒ hệ số jitter đúng 1, chu kỳ tất định
      stats: { intervalMs: INTERVAL_MS, random: () => 0.5, ...stats },
    },
  );
}

/** Transport đã nạp sẵn một snapshot và một stream im lặng */
function readyTransport(flags = [flag("f"), flag("g")]): InMemoryTransport {
  const transport = new InMemoryTransport();
  transport.configs.push({
    kind: "ok",
    body: configBody(1, flags),
    etag: '"1"',
  });
  transport.streams.push(new ScriptedStream());
  return transport;
}

/** Mọi mục của mọi báo cáo, gộp lại theo `flagKey|variant` */
function totals(reports: readonly SdkStatsReport[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const report of reports) {
    for (const entry of report.counts) {
      const key = `${entry.flagKey}|${entry.variant}`;
      out[key] = (out[key] ?? 0) + entry.count;
    }
  }
  return out;
}

async function evaluateBoolean(
  provider: UDPFeatureFlagProvider,
  key: string,
  times = 1,
): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    await provider.resolveBooleanEvaluation(key, false, {});
  }
}

describe("bộ đếm", () => {
  it("đếm theo (flagKey, variant); close ⇒ đúng MỘT postStats mang đủ lượt", async () => {
    const t = readyTransport();
    const provider = providerWith(t, {}, { intervalMs: 60_000 });
    await provider.initialize();
    await evaluateBoolean(provider, "f", 3);
    await evaluateBoolean(provider, "g", 2);
    await provider.onClose();

    expect(t.statsReports).toHaveLength(1);
    expect(totals(t.statsReports)).toEqual({ "f|on": 3, "g|on": 2 });
    expect(t.statsReports[0]?.sdk?.name).toBe("udp-openfeature-provider");
  });

  it("flag tắt ⇒ __disabled__; sai kiểu ⇒ __error__; FLAG_NOT_FOUND và PROVIDER_NOT_READY không đếm", async () => {
    const t = readyTransport([
      flag("off-flag", { isEnabled: false }),
      flag("text", { type: "STRING", variants: { on: "x" } }),
      flag("f"),
    ]);
    const provider = providerWith(t, {}, { intervalMs: 60_000 });

    // Chưa `initialize()` ⇒ PROVIDER_NOT_READY: key lạ của ứng dụng khách không
    // được phình bộ đếm (V8)
    await evaluateBoolean(provider, "f", 5);
    await provider.initialize();

    await evaluateBoolean(provider, "off-flag");
    // Flag STRING đọc bằng getBoolean ⇒ TYPE_MISMATCH của lõi
    await evaluateBoolean(provider, "text");
    await evaluateBoolean(provider, "khong-ton-tai", 4);
    await evaluateBoolean(provider, "f");
    await provider.onClose();

    expect(totals(t.statsReports)).toEqual({
      "off-flag|__disabled__": 1,
      "text|__error__": 1,
      "f|on": 1,
    });
  });

  it("hết intervalMs ⇒ một báo cáo; cửa sổ rỗng ⇒ không request nào", async () => {
    const t = readyTransport();
    const provider = providerWith(t);
    await provider.initialize();
    await evaluateBoolean(provider, "f", 7);

    await waitFor(() => t.statsReports.length === 1);
    expect(totals(t.statsReports)).toEqual({ "f|on": 7 });

    // Vài chu kỳ rỗng tiếp theo không được phát sinh request
    await new Promise((r) => setTimeout(r, INTERVAL_MS * 4));
    expect(t.statsReports).toHaveLength(1);
    await provider.onClose();
    expect(t.statsReports).toHaveLength(1);
  });

  it("close với bộ đếm RỖNG không gọi postStats (V7)", async () => {
    const t = readyTransport();
    const provider = providerWith(t, {}, { intervalMs: 60_000 });
    await provider.initialize();
    await provider.onClose();
    expect(t.statsReports).toEqual([]);
  });

  it("reportStats: false ⇒ không đếm, không timer, không request", async () => {
    const t = readyTransport();
    const provider = providerWith(t, { reportStats: false });
    await provider.initialize();
    await evaluateBoolean(provider, "f", 3);
    await new Promise((r) => setTimeout(r, INTERVAL_MS * 4));
    await provider.onClose();
    expect(t.statsReports).toEqual([]);
  });

  it("một lô không bao giờ vượt maxEntriesPerReport; phần dư đi lượt sau", async () => {
    const t = readyTransport();
    const provider = providerWith(
      t,
      {},
      { intervalMs: 60_000, maxEntriesPerReport: 1 },
    );
    await provider.initialize();
    await evaluateBoolean(provider, "f", 2);
    await evaluateBoolean(provider, "g", 3);
    await provider.onClose();

    // `close` gửi đúng MỘT lô: phần dư ở lại chứ không bị nhồi vào cùng báo cáo
    expect(t.statsReports).toHaveLength(1);
    expect(t.statsReports[0]?.counts).toHaveLength(1);
  });
});

describe("phân loại phản hồi (V7)", () => {
  it("429 ⇒ gộp lô lại và tôn trọng Retry-After", async () => {
    const t = readyTransport();
    t.stats.push({ kind: "retry", retryAfterMs: 1_000 });
    const provider = providerWith(t);
    await provider.initialize();
    await evaluateBoolean(provider, "f", 2);

    await waitFor(() => t.statsReports.length === 1);
    await evaluateBoolean(provider, "f", 3);
    // Retry-After 1 000 ms ≫ chu kỳ 25 ms: lượt sau KHÔNG được tới sớm
    await new Promise((r) => setTimeout(r, INTERVAL_MS * 8));
    expect(t.statsReports).toHaveLength(1);

    await waitFor(() => t.statsReports.length === 2, 3_000);
    await provider.onClose();
    // Lô bị từ chối được gộp lại, không mất và không đếm đôi
    expect(totals(t.statsReports)).toEqual({ "f|on": 2 + 2 + 3 });
  }, 10_000);

  it("quá hạn / mã lạ ⇒ BỎ lô, không bao giờ gửi lại (không đếm đôi)", async () => {
    const t = readyTransport();
    t.stats.push({ kind: "ambiguous" });
    const provider = providerWith(t);
    await provider.initialize();
    await evaluateBoolean(provider, "f", 4);

    await waitFor(() => t.statsReports.length === 1);
    await evaluateBoolean(provider, "f", 1);
    await waitFor(() => t.statsReports.length === 2);
    await provider.onClose();
    expect(totals(t.statsReports)).toEqual({ "f|on": 4 + 1 });
  });

  it("400 ⇒ bỏ lô và đúng MỘT chẩn đoán cho cả phiên", async () => {
    const warnings: string[] = [];
    const t = readyTransport();
    t.defaultStats = { kind: "rejected" };
    const provider = providerWith(t, {
      logger: { warn: (m) => warnings.push(String(m)) },
    });
    await provider.initialize();
    for (let i = 0; i < 4; i += 1) {
      await evaluateBoolean(provider, "f");
      await waitFor(() => t.statsReports.length === i + 1);
    }
    await provider.onClose();
    expect(warnings.filter((w) => w.includes("/sdk/stats"))).toHaveLength(1);
  });

  it("404 (Service 2 chưa có route) ⇒ ngừng gửi; khoá được nhận lại ⇒ gửi tiếp", async () => {
    const t = readyTransport();
    t.stats.push({ kind: "stop" });
    const first = t.streams[0] as ScriptedStream;
    // Sau khi stream đầu kết thúc: 401 ⇒ vòng đồng bộ chuyển sang polling, và lượt
    // poll kế đọc cấu hình này ⇒ `onAuthorized` ⇒ READY trở lại
    t.streams.push({ kind: "unauthorized" });
    t.configs.push({
      kind: "ok",
      body: configBody(2, [flag("f")]),
      etag: '"2"',
    });
    const provider = providerWith(t);
    await provider.initialize();

    await evaluateBoolean(provider, "f", 2);
    await waitFor(() => t.statsReports.length === 1);
    await evaluateBoolean(provider, "f", 3);
    await new Promise((r) => setTimeout(r, INTERVAL_MS * 6));
    expect(t.statsReports).toHaveLength(1);

    first.end();
    await waitFor(() => t.statsReports.length === 2, 5_000);
    await provider.onClose();
    expect(totals(t.statsReports)).toEqual({ "f|on": 2 + 3 });
  }, 10_000);
});

describe("không chặn ứng dụng khách (R19)", () => {
  it("postStats ném hoặc hỏng ⇒ không lọt vào ứng dụng; đánh giá vẫn đúng (I33)", async () => {
    const t = readyTransport();
    t.stats.push("throw", { kind: "retry", retryAfterMs: undefined });
    const provider = providerWith(t);
    await provider.initialize();
    await evaluateBoolean(provider, "f", 2);
    // Lô đầu: transport NÉM ⇒ coi như mơ hồ, bỏ lô, vòng lặp vẫn chạy tiếp
    await waitFor(() => t.statsReports.length === 1);
    await evaluateBoolean(provider, "f", 1);
    await waitFor(() => t.statsReports.length >= 2);
    const details = await provider.resolveBooleanEvaluation("f", false, {});
    expect(details.value).toBe(true);
    expect(details.errorCode).toBeUndefined();
    await provider.onClose();
  });

  it("close trong lúc một báo cáo đang bay: về trong hạn, KHÔNG báo đôi", async () => {
    const t = readyTransport();
    t.stats.push("hang");
    const provider = providerWith(t, {}, { shutdownFlushTimeoutMs: 150 });
    await provider.initialize();
    await evaluateBoolean(provider, "f", 2);
    await waitFor(() => t.statsReports.length === 1);

    const started = Date.now();
    await provider.onClose();
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(t.statsReports).toHaveLength(1);
  });

  it("server treo ở lần gửi cuối: close vẫn về trong hạn và không ném", async () => {
    const t = readyTransport();
    t.defaultStats = { kind: "accepted" };
    t.stats.push("hang");
    const provider = providerWith(
      t,
      {},
      { intervalMs: 60_000, shutdownFlushTimeoutMs: 150 },
    );
    await provider.initialize();
    await evaluateBoolean(provider, "f");
    const started = Date.now();
    await expect(provider.onClose()).resolves.toBeUndefined();
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it("đánh giá với ngữ cảnh và key bất kỳ không bao giờ ném khi stats BẬT (I33)", async () => {
    const t = readyTransport();
    t.defaultStats = { kind: "ambiguous" };
    const provider = providerWith(t, {}, { intervalMs: 5 });
    await provider.initialize();
    await fc.assert(
      fc.asyncProperty(
        fc.string(),
        fc.dictionary(fc.string(), fc.anything()),
        async (key, context) => {
          const details = await provider.resolveBooleanEvaluation(
            key,
            false,
            context as Record<string, never>,
          );
          expect(typeof details.value).toBe("boolean");
        },
      ),
      { numRuns: 60 },
    );
    await provider.onClose();
  }, 30_000);

  it("timer được unref: tiến trình của khách thoát dù quên OpenFeature.close()", async () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const { stdout } = await promisify(execFile)(
      process.execPath,
      ["--import", "tsx", resolve(here, "fixtures/stats-exit-probe.ts")],
      { cwd: resolve(here, ".."), timeout: 30_000 },
    );
    expect(stdout).toContain("đã đánh giá: true");
  }, 40_000);
});

describe("StatsCounter", () => {
  const counter = (max = 10_000): StatsCounter =>
    new StatsCounter(max, SDK_STATS.report.maxCountPerEntry);

  it("chạm trần thì bỏ cặp MỚI, không bỏ lượt của cặp đã có", () => {
    const c = counter(2);
    c.record("a", "on");
    c.record("b", "on");
    c.record("c", "on");
    c.record("a", "on");
    expect(c.take(100)).toEqual([
      { flagKey: "a", variant: "on", count: 2 },
      { flagKey: "b", variant: "on", count: 1 },
    ]);
    expect(c.isEmpty).toBe(true);
  });

  it("bão hoà ở maxCountPerEntry thay vì làm Service 2 trả 400", () => {
    const c = new StatsCounter(10, 3);
    c.record("a", "on");
    c.restore([{ flagKey: "a", variant: "on", count: 99 }]);
    expect(c.take(10)).toEqual([{ flagKey: "a", variant: "on", count: 3 }]);
  });

  it("property: flushed + pending = input, và không lô nào có count 0 hay khoá trùng", () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.tuple(
            fc.constantFrom("a", "b", "c"),
            fc.constantFrom("on", "off", "__disabled__"),
          ),
          { maxLength: 200 },
        ),
        fc.integer({ min: 1, max: 4 }),
        (events, limit) => {
          const c = counter();
          const input: Record<string, number> = {};
          for (const [key, variant] of events) {
            c.record(key, variant);
            input[`${key}|${variant}`] = (input[`${key}|${variant}`] ?? 0) + 1;
          }
          const flushed: Record<string, number> = {};
          for (;;) {
            const batch = c.take(limit);
            if (batch.length === 0) break;
            expect(batch.length).toBeLessThanOrEqual(limit);
            const seen = new Set<string>();
            for (const entry of batch) {
              const id = `${entry.flagKey}|${entry.variant}`;
              expect(entry.count).toBeGreaterThan(0);
              expect(seen.has(id)).toBe(false);
              seen.add(id);
              flushed[id] = (flushed[id] ?? 0) + entry.count;
            }
          }
          expect(flushed).toEqual(input);
          expect(c.isEmpty).toBe(true);
        },
      ),
      { numRuns: 100 },
    );
  });
});

describe("StatsReporter", () => {
  const evaluation = (variant: string): Evaluation => ({
    reason: "TARGETING_MATCH",
    value: true,
    variant,
  });

  it("resume() sau stop mới gửi tiếp (V7: tới lần READY kế)", async () => {
    const t = new InMemoryTransport();
    t.stats.push({ kind: "stop" });
    const reporter = new StatsReporter(t, () => undefined, {
      intervalMs: INTERVAL_MS,
      random: () => 0.5,
    });
    reporter.start();
    reporter.record("a", evaluation("on"));
    await waitFor(() => t.statsReports.length === 1);

    reporter.record("a", evaluation("on"));
    await new Promise((r) => setTimeout(r, INTERVAL_MS * 6));
    expect(t.statsReports).toHaveLength(1);

    reporter.resume();
    await waitFor(() => t.statsReports.length === 2);
    await reporter.close();
    expect(totals(t.statsReports)).toEqual({ "a|on": 2 });
  });

  it("record sau close không đếm gì nữa, và close hai lần là vô hại", async () => {
    const t = new InMemoryTransport();
    const reporter = new StatsReporter(t, () => undefined, {
      intervalMs: 60_000,
    });
    reporter.start();
    reporter.record("a", evaluation("on"));
    await reporter.close();
    reporter.record("a", evaluation("on"));
    await reporter.close();
    expect(totals(t.statsReports)).toEqual({ "a|on": 1 });
  });
});
