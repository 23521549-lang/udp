import { execFile } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { OpenFeature, ProviderEvents } from "@openfeature/server-sdk";
import fc from "fast-check";
import { afterEach, describe, expect, it } from "vitest";
import { requestStore, UDPFeatureFlagProvider } from "../src/index.js";
import {
  configBody,
  deltaBody,
  InMemoryTransport,
  flag,
  ScriptedStream,
  createProviderForTesting,
  type SyncOptions,
} from "../src/testing.js";
import { waitFor } from "./helpers/wait.js";

/**
 * Provider qua SDK OpenFeature THẬT (§6.8) với transport giả: vòng đời init, sự
 * kiện (SDK tự phát READY/ERROR của init — provider không phát lặp), ánh xạ
 * reason/errorCode, fail-static, hook tự gắn, và I33 (không bao giờ ném).
 */

afterEach(async () => {
  await OpenFeature.close();
});

function providerWith(
  transport: InMemoryTransport,
  sync: Partial<SyncOptions> = {},
  initTimeoutMs = 2_000,
): UDPFeatureFlagProvider {
  return createProviderForTesting(
    { host: "http://unused", sdkKey: "k", initTimeoutMs },
    {
      transport,
      sync: {
        pollingIntervalMs: 50,
        backoffMinMs: 5,
        staleCheckMs: 10,
        random: () => 0.5,
        ...sync,
      },
    },
  );
}

const ruleOn = {
  id: "r1",
  type: "USER_BASED",
  condition: { userIds: ["u1"] },
  serve: { kind: "variant", variantKey: "on" },
  bucketSalt: "s",
  priority: 0,
};

describe("vòng đời", () => {
  it("init chờ snapshot đầu; đánh giá tại chỗ với variant, reason, ruleId", async () => {
    const t = new InMemoryTransport();
    t.configs.push({
      kind: "ok",
      body: configBody(1, [
        flag("f", { defaultVariantKey: "off", rules: [ruleOn] as never }),
      ]),
      etag: '"1"',
    });
    t.streams.push(new ScriptedStream());
    await OpenFeature.setProviderAndWait(providerWith(t));
    const client = OpenFeature.getClient();
    const hit = await client.getBooleanDetails("f", false, {
      targetingKey: "u1",
    });
    expect(hit).toMatchObject({
      value: true,
      variant: "on",
      reason: "TARGETING_MATCH",
      flagMetadata: { ruleId: "r1" },
    });
    const miss = await client.getBooleanDetails("f", true, {
      targetingKey: "u2",
    });
    expect(miss).toMatchObject({
      value: false,
      variant: "off",
      reason: "DEFAULT",
    });
  });

  it("init quá hạn ⇒ setProviderAndWait NÉM; dữ liệu về sau ⇒ provider phát READY, đánh giá đúng", async () => {
    const t = new InMemoryTransport();
    const stream = new ScriptedStream();
    t.streams.push(stream);
    const provider = providerWith(t, {}, 100);
    await expect(OpenFeature.setProviderAndWait(provider)).rejects.toThrow();
    const client = OpenFeature.getClient();
    expect((await client.getBooleanDetails("f", true)).errorCode).toBe(
      "PROVIDER_NOT_READY",
    );
    let ready = false;
    client.addHandler(ProviderEvents.Ready, () => {
      ready = true;
    });
    stream.event("snapshot", configBody(1, [flag("f")]));
    await waitFor(() => ready);
    expect(await client.getBooleanValue("f", false)).toBe(true);
  });

  it("401 lúc init ⇒ ném NGAY, không chờ hết hạn", async () => {
    const t = new InMemoryTransport();
    t.configs.push({ kind: "unauthorized" });
    const started = Date.now();
    await expect(
      OpenFeature.setProviderAndWait(providerWith(t, {}, 5_000)),
    ).rejects.toThrow(/401/);
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it("CONFIGURATION_CHANGED mang flagsChanged theo nội dung thật sự đổi", async () => {
    const t = new InMemoryTransport();
    t.configs.push({
      kind: "ok",
      body: configBody(1, [flag("a"), flag("b")]),
      etag: '"1"',
    });
    const stream = new ScriptedStream();
    t.streams.push(stream);
    await OpenFeature.setProviderAndWait(providerWith(t));
    const changes: (string[] | undefined)[] = [];
    OpenFeature.getClient().addHandler(
      ProviderEvents.ConfigurationChanged,
      (e) => {
        changes.push(e?.flagsChanged);
      },
    );
    const after = {
      flags: [flag("a", { isEnabled: false }), flag("b")],
      segments: [],
      trackedFlags: ["a"],
    };
    stream.event(
      "flag_changed",
      deltaBody(1, 2, after, [
        {
          configVersion: 2,
          kind: "flag",
          flag: flag("a", { isEnabled: false }),
        },
        { configVersion: 2, kind: "trackedFlags", trackedFlags: ["a"] },
      ]),
    );
    await waitFor(() => changes.length === 1);
    expect(changes).toEqual([["a"]]);
  });
});

describe("cấu hình", () => {
  it("staleAfterSeconds không dài hơn nhịp tim hoặc chu kỳ polling ⇒ RangeError lúc dựng", () => {
    const build = (staleAfterSeconds: number, pollingIntervalMs?: number) =>
      new UDPFeatureFlagProvider({
        host: "http://unused",
        sdkKey: "k",
        staleAfterSeconds,
        ...(pollingIntervalMs === undefined ? {} : { pollingIntervalMs }),
      });
    expect(() => build(30)).toThrow(RangeError);
    expect(() => build(50)).toThrow(RangeError);
    expect(() => build(100, 120_000)).toThrow(RangeError);
    expect(() => build(Number.NaN)).toThrow(RangeError);
    expect(() => build(60)).not.toThrow();
  });

  it("số không dương/NaN ở các tuỳ chọn khác ⇒ RangeError (backoff 0 là vòng lặp NÓNG)", () => {
    const base = { host: "http://unused", sdkKey: "k" };
    for (const bad of [
      { pollingIntervalMs: 0 },
      { pollingIntervalMs: Number.NaN },
      { sseFailuresBeforeFallback: 0 },
      { sseFailuresBeforeFallback: 1.5 },
      { initTimeoutMs: Number.NaN },
      { initTimeoutMs: -1 },
    ]) {
      expect(() => new UDPFeatureFlagProvider({ ...base, ...bad })).toThrow(
        RangeError,
      );
    }
  });
});

describe("ánh xạ kết quả", () => {
  async function client(flags: Parameters<typeof configBody>[1]) {
    const t = new InMemoryTransport();
    t.configs.push({ kind: "ok", body: configBody(1, flags), etag: '"1"' });
    t.streams.push(new ScriptedStream());
    await OpenFeature.setProviderAndWait(providerWith(t));
    return OpenFeature.getClient();
  }

  it("DISABLED ⇒ default của code; bia mộ ⇒ archived; không có ⇒ FLAG_NOT_FOUND; sai kiểu ⇒ TYPE_MISMATCH", async () => {
    const c = await client([
      flag("off", { isEnabled: false }),
      { key: "old", archived: true },
    ]);
    expect(await c.getBooleanDetails("off", true)).toMatchObject({
      value: true,
      reason: "DISABLED",
    });
    expect(await c.getBooleanDetails("old", false)).toMatchObject({
      reason: "DISABLED",
      flagMetadata: { archived: true },
    });
    expect((await c.getBooleanDetails("none", false)).errorCode).toBe(
      "FLAG_NOT_FOUND",
    );
    expect((await c.getStringDetails("off", "x")).errorCode).toBe(
      "TYPE_MISMATCH",
    );
  });

  it("Date trong context theo ngữ nghĩa JSON (chuỗi ISO) — như OFREP nhận qua dây (I26)", async () => {
    const at = new Date("2026-09-22T00:00:00.000Z");
    const c = await client([
      flag("d", {
        defaultVariantKey: "off",
        rules: [
          {
            id: "r",
            type: "ATTRIBUTE_BASED",
            condition: {
              all: [
                { attribute: "since", operator: "eq", value: at.toISOString() },
              ],
            },
            serve: { kind: "variant", variantKey: "on" },
            bucketSalt: "s",
            priority: 0,
          },
        ] as never,
      }),
    ]);
    expect(await c.getBooleanValue("d", false, { since: at })).toBe(true);
  });
});

describe("hook tự gắn — nhãn ff theo request (§6.6)", () => {
  it("chỉ tracked flag có variant được ghi vào store của request", async () => {
    const t = new InMemoryTransport();
    t.configs.push({
      kind: "ok",
      body: configBody(
        1,
        [flag("t"), flag("u"), flag("off", { isEnabled: false })],
        ["t", "off"],
      ),
      etag: '"1"',
    });
    t.streams.push(new ScriptedStream());
    await OpenFeature.setProviderAndWait(providerWith(t));
    const c = OpenFeature.getClient();
    const labels = { flags: new Map<string, string>() };
    await requestStore.run(labels, async () => {
      await c.getBooleanValue("t", false);
      await c.getBooleanValue("u", false);
      await c.getBooleanValue("off", false);
    });
    expect([...labels.flags]).toEqual([["t", "on"]]);
  });
});

describe("I33 — không bao giờ ném, với dữ liệu dây và context bất kỳ", () => {
  it("fuzz: snapshot rác từ transport, context rác ⇒ luôn trả đúng kiểu, không ngoại lệ", async () => {
    await fc.assert(
      fc.asyncProperty(fc.anything(), fc.anything(), async (body, context) => {
        const t = new InMemoryTransport();
        t.configs.push({ kind: "ok", body, etag: '"1"' });
        const s = new ScriptedStream();
        t.streams.push(s);
        s.event("snapshot", body);
        const provider = providerWith(t, {}, 50);
        await OpenFeature.setProviderAndWait(provider).catch(() => undefined);
        const c = OpenFeature.getClient();
        const ctx =
          typeof context === "object" &&
          context !== null &&
          !Array.isArray(context)
            ? (context as Record<string, never>)
            : {};
        expect(typeof (await c.getBooleanValue("f", false, ctx))).toBe(
          "boolean",
        );
        expect(typeof (await c.getStringValue("f", "d", ctx))).toBe("string");
        expect(typeof (await c.getNumberValue("f", 1, ctx))).toBe("number");
        expect(await c.getObjectValue("f", { a: 1 }, ctx)).toBeTypeOf("object");
        await OpenFeature.close();
      }),
      { numRuns: 40 },
    );
  });
});

describe("chỗ tiêm test (Plan #22, Y8)", () => {
  it("constructor ném giữa chừng ⇒ khe vẫn được xoá: provider dựng SAU không nhặt transport giả", async () => {
    const t = new InMemoryTransport();
    expect(() =>
      createProviderForTesting(
        { host: "http://unused", sdkKey: "k", pollingIntervalMs: 0 },
        { transport: t },
      ),
    ).toThrow(RangeError);
    const plain = new UDPFeatureFlagProvider({
      host: "http://127.0.0.1:9",
      sdkKey: "k",
      initTimeoutMs: 100,
      fetch: () => Promise.reject(new TypeError("fetch failed")),
    });
    await expect(plain.initialize()).rejects.toThrow();
    await plain.onClose();
    expect(t.configCalls).toEqual([]);
    expect(t.streamCalls).toEqual([]);
  });
});

describe("hồi quy QA code Plan #21", () => {
  it("Service 2 không tới được: tiến trình SỐNG tới lúc init hết hạn (timer init không unref)", async () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const { stdout } = await promisify(execFile)(
      process.execPath,
      ["--import", "tsx", resolve(here, "fixtures/init-exit-probe.ts")],
      { cwd: resolve(here, ".."), timeout: 30_000 },
    );
    expect(stdout).toContain("init rejected");
  }, 40_000);

  it("401 lúc init rồi khoá được nhận lại ⇒ đúng MỘT READY của provider", async () => {
    const t = new InMemoryTransport();
    t.configs.push(
      { kind: "unauthorized" },
      { kind: "ok", body: configBody(1, [flag("f")]), etag: '"1"' },
    );
    t.streams.push(new ScriptedStream());
    const provider = providerWith(t);
    const readies: number[] = [];
    provider.events.addHandler(ProviderEvents.Ready, () =>
      readies.push(Date.now()),
    );
    await expect(OpenFeature.setProviderAndWait(provider)).rejects.toThrow(
      /401/,
    );
    await waitFor(() => provider.configVersion === 1);
    await new Promise((r) => setTimeout(r, 100));
    expect(readies).toHaveLength(1);
  });

  it("đóng giữa lúc init ⇒ init kết thúc NGAY, không chờ hết hạn", async () => {
    const provider = providerWith(new InMemoryTransport(), {}, 10_000);
    const started = Date.now();
    const init = provider.initialize();
    await provider.onClose();
    await expect(init).rejects.toThrow(/đóng/);
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it("context theo ngữ nghĩa JSON như OFREP: NaN ⇒ null (thuộc tính vắng), Date lồng ⇒ chuỗi", async () => {
    const t = new InMemoryTransport();
    t.configs.push({
      kind: "ok",
      body: configBody(1, [
        flag("n", {
          defaultVariantKey: "off",
          rules: [
            {
              id: "r",
              type: "ATTRIBUTE_BASED",
              condition: {
                all: [{ attribute: "age", operator: "neq", value: 5 }],
              },
              serve: { kind: "variant", variantKey: "on" },
              bucketSalt: "s",
              priority: 0,
            },
          ] as never,
        }),
      ]),
      etag: '"1"',
    });
    t.streams.push(new ScriptedStream());
    await OpenFeature.setProviderAndWait(providerWith(t));
    const c = OpenFeature.getClient();
    // Qua dây OFREP `NaN` thành `null` ⇒ thuộc tính vắng ⇒ mọi toán tử false (kể cả neq)
    expect(
      await c.getBooleanDetails("n", true, { age: Number.NaN }),
    ).toMatchObject({
      value: false,
      reason: "DEFAULT",
    });
    expect(await c.getBooleanValue("n", false, { age: 7 })).toBe(true);
  });
});

describe("I33 — fuzz trên cấu hình THẬT (không chỉ nhánh chưa READY)", () => {
  const typed = [
    flag("b"),
    flag("s", { type: "STRING", variants: { on: "x", off: "y" } }),
    flag("n", { type: "NUMBER", variants: { on: 1, off: 2 } }),
    flag("j", { type: "JSON", variants: { on: { a: 1 }, off: [] } }),
    {
      ...flag("r"),
      rules: [
        {
          id: "r1",
          type: "ATTRIBUTE_BASED",
          condition: {
            all: [
              { attribute: "plan", operator: "in", value: ["pro"] },
              { attribute: "v", operator: "semverGte", value: "1.2.0" },
              { attribute: "e", operator: "regex", value: "^a.*$" },
            ],
          },
          serve: {
            kind: "distribution",
            weights: [
              { variantKey: "on", weight: 50_000 },
              { variantKey: "off", weight: 50_000 },
            ],
          },
          bucketSalt: "s",
          priority: 0,
        },
      ],
    },
  ] as Parameters<typeof configBody>[1];

  it("context bất kỳ trên snapshot thật ⇒ đúng kiểu, không ném, và phép so KHÔNG rỗng", async () => {
    const t = new InMemoryTransport();
    t.configs.push({ kind: "ok", body: configBody(1, typed), etag: '"1"' });
    t.streams.push(new ScriptedStream());
    await OpenFeature.setProviderAndWait(providerWith(t));
    const c = OpenFeature.getClient();
    const reasons = new Set<string>();
    await fc.assert(
      fc.asyncProperty(
        fc.dictionary(fc.string(), fc.anything()),
        fc.constantFrom("b", "s", "n", "j", "r", "missing"),
        async (context, key) => {
          const ctx = context as Record<string, never>;
          const d = await c.getBooleanDetails(key, false, ctx);
          expect(typeof d.value).toBe("boolean");
          reasons.add(d.reason ?? "");
          expect(typeof (await c.getStringValue(key, "d", ctx))).toBe("string");
          expect(typeof (await c.getNumberValue(key, 1, ctx))).toBe("number");
          expect(await c.getObjectValue(key, { a: 1 }, ctx)).toBeTypeOf(
            "object",
          );
        },
      ),
      { numRuns: 200 },
    );
    expect(reasons.has("ERROR")).toBe(true);
    expect([...reasons].some((r) => r !== "ERROR")).toBe(true);
  });

  it("event rác SAU khi READY (tên lạ, JSON hỏng, delta sai hình) ⇒ vẫn phục vụ đúng kiểu", async () => {
    const t = new InMemoryTransport();
    t.configs.push({ kind: "ok", body: configBody(1, typed), etag: '"1"' });
    t.defaultConfig = { kind: "not-modified" };
    const streams = Array.from({ length: 200 }, () => new ScriptedStream());
    t.streams.push(...streams);
    await OpenFeature.setProviderAndWait(providerWith(t));
    const c = OpenFeature.getClient();
    let i = 0;
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom(
          "snapshot",
          "flag_changed",
          "segment_changed",
          "message",
        ),
        fc.anything(),
        async (event, data) => {
          const s = streams[Math.min(i, streams.length - 1)] as ScriptedStream;
          i += 1;
          s.event(event, data);
          await new Promise((r) => setTimeout(r, 1));
          expect(typeof (await c.getBooleanValue("b", false))).toBe("boolean");
          expect(typeof (await c.getStringValue("s", "d"))).toBe("string");
        },
      ),
      { numRuns: 60 },
    );
  });
});
