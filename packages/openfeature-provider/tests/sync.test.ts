import { afterEach, describe, expect, it } from "vitest";
import { ConfigStore } from "../src/store.js";
import { Synchronizer, type SyncListener } from "../src/sync.js";
import {
  configBody,
  deltaBody,
  InMemoryTransport,
  flag,
  ScriptedStream,
} from "../src/testing.js";
import { waitFor } from "./helpers/wait.js";

/**
 * Vòng đồng bộ (§6.3, §6.8) với transport giả — tất định, không mạng: I15a (nội
 * dung sai ⇒ RESYNC), I18 (hổng con trỏ ⇒ RESYNC), rơi về polling, STALE và hồi
 * phục (I34), 401, watchdog kết nối nửa mở.
 */

interface Harness {
  transport: InMemoryTransport;
  store: ConfigStore;
  sync: Synchronizer;
  log: string[];
}

const running: Synchronizer[] = [];
afterEach(() => {
  for (const s of running.splice(0)) s.close();
});

function harness(
  overrides: Partial<ConstructorParameters<typeof Synchronizer>[2]> = {},
): Harness {
  const transport = new InMemoryTransport();
  const store = new ConfigStore();
  const log: string[] = [];
  const listener: SyncListener = {
    onFirstData: () => log.push("first"),
    onChanged: (keys) => log.push(`changed:${keys.join(",")}`),
    onStale: () => log.push("stale"),
    onFresh: () => log.push("fresh"),
    onUnauthorized: () => log.push("unauthorized"),
    onAuthorized: () => log.push("authorized"),
    onDiagnostic: (message) => log.push(`diag:${message}`),
  };
  const sync = new Synchronizer(
    transport,
    store,
    {
      pollingIntervalMs: 60,
      sseFailuresBeforeFallback: 3,
      staleAfterMs: 10_000,
      heartbeatTimeoutMs: 5_000,
      backoffMinMs: 5,
      requestTimeoutMs: 1_000,
      staleCheckMs: 10,
      random: () => 0.5,
      now: Date.now,
      ...overrides,
    },
    listener,
  );
  running.push(sync);
  return { transport, store, sync, log };
}

describe("bootstrap và delta", () => {
  it("GET /sdk/config rồi mở stream từ ĐÚNG version đã áp; delta đổi nội dung ⇒ changed", async () => {
    const h = harness();
    const v1 = configBody(1, [flag("a")]);
    h.transport.configs.push({ kind: "ok", body: v1, etag: '"1"' });
    const stream = new ScriptedStream();
    h.transport.streams.push(stream);
    h.sync.start();
    await waitFor(() => h.log.includes("first"));
    await waitFor(() => h.transport.streamCalls.length === 1);
    expect(h.transport.streamCalls).toEqual([1]);

    const after = {
      flags: [flag("a", { isEnabled: false })],
      segments: [],
      trackedFlags: [],
    };
    stream.event(
      "flag_changed",
      deltaBody(1, 2, after, [
        {
          configVersion: 2,
          kind: "flag",
          flag: flag("a", { isEnabled: false }),
        },
      ]),
    );
    await waitFor(() => h.store.configVersion === 2);
    expect(h.log).toContain("changed:a");

    // event cũ (toVersion ≤ con trỏ) bị bỏ qua, không lỗi
    stream.event("flag_changed", deltaBody(1, 2, after, []));
    stream.event(
      "flag_changed",
      deltaBody(2, 3, after, [
        { configVersion: 3, kind: "flagAbsent", key: "draft" },
      ]),
    );
    await waitFor(() => h.store.configVersion === 3);
    // flagAbsent của một flag vốn đã vắng không phải thay đổi
    expect(h.log.filter((l) => l.startsWith("changed"))).toEqual(["changed:a"]);
  });

  it("bootstrap 503 ⇒ KHÔNG chờ: stream không con trỏ, event snapshot là bootstrap", async () => {
    const h = harness();
    h.transport.configs.push({ kind: "unavailable", retryAfterMs: 60_000 });
    const stream = new ScriptedStream();
    h.transport.streams.push(stream);
    h.sync.start();
    await waitFor(() => h.transport.streamCalls.length === 1);
    expect(h.transport.streamCalls).toEqual([undefined]);
    stream.event("snapshot", configBody(4, [flag("a")]));
    await waitFor(() => h.log.includes("first"));
    expect(h.store.configVersion).toBe(4);
  });
});

describe("RESYNC — cache có thể sai thì mở lại KHÔNG con trỏ", () => {
  it("I15a: delta đúng SỐ sai NỘI DUNG ⇒ RESYNC, snapshot mới thay cache", async () => {
    const h = harness();
    h.transport.configs.push({
      kind: "ok",
      body: configBody(1, [flag("a")]),
      etag: '"1"',
    });
    const first = new ScriptedStream();
    const second = new ScriptedStream();
    h.transport.streams.push(first, second);
    h.sync.start();
    await waitFor(() => h.transport.streamCalls.length === 1);

    first.event("flag_changed", {
      fromVersion: 1,
      toVersion: 2,
      configHash: "f".repeat(64),
      changes: [
        {
          configVersion: 2,
          kind: "flag",
          flag: flag("a", { isEnabled: false }),
        },
      ],
    });
    await waitFor(() => h.transport.streamCalls.length === 2);
    expect(h.transport.streamCalls[1]).toBeUndefined();
    expect(h.store.configVersion).toBe(1); // kết quả áp sai bị vứt

    second.event("snapshot", configBody(2, [flag("a", { isEnabled: false })]));
    await waitFor(() => h.store.configVersion === 2);
    expect(h.store.needsResync).toBe(false);
  });

  it("I18: hổng con trỏ ⇒ RESYNC; event lạ ⇒ RESYNC; JSON hỏng ⇒ RESYNC", async () => {
    for (const bad of [
      (s: ScriptedStream) =>
        s.event("flag_changed", {
          fromVersion: 5,
          toVersion: 6,
          configHash: "",
          changes: [],
        }),
      (s: ScriptedStream) => s.event("segment_changed", {}),
      (s: ScriptedStream) =>
        s.push({
          kind: "event",
          event: "snapshot",
          data: "{hỏng",
          id: undefined,
        }),
    ]) {
      const h = harness();
      h.transport.configs.push({
        kind: "ok",
        body: configBody(1, [flag("a")]),
        etag: '"1"',
      });
      const s1 = new ScriptedStream();
      h.transport.streams.push(s1, new ScriptedStream());
      h.sync.start();
      await waitFor(() => h.transport.streamCalls.length === 1);
      bad(s1);
      await waitFor(() => h.transport.streamCalls.length === 2);
      expect(h.transport.streamCalls[1]).toBeUndefined();
      h.sync.close();
    }
  });

  it("snapshot với version THẤP hơn vẫn thay cache (database được khôi phục)", async () => {
    const h = harness();
    h.transport.configs.push({
      kind: "ok",
      body: configBody(9, [flag("a")]),
      etag: '"9"',
    });
    const s = new ScriptedStream();
    h.transport.streams.push(s);
    h.sync.start();
    await waitFor(() => h.transport.streamCalls.length === 1);
    s.event("snapshot", configBody(3, [flag("b")]));
    await waitFor(() => h.store.configVersion === 3);
  });
});

describe("mất stream — polling, STALE, hồi phục (I34)", () => {
  it("3 lần hỏng liên tiếp ⇒ polling (revalidate bằng ETag); stream GỬI được byte ⇒ thôi polling", async () => {
    const h = harness();
    h.transport.configs.push({
      kind: "ok",
      body: configBody(1, [flag("a")]),
      etag: '"1"',
    });
    h.transport.defaultConfig = { kind: "not-modified" };
    h.sync.start();
    await waitFor(() => h.transport.configCalls.length >= 2, 5_000);
    expect(h.transport.streamCalls.length).toBeGreaterThanOrEqual(3);
    expect(h.transport.configCalls.slice(1).every((t) => t === '"1"')).toBe(
      true,
    );

    const s = new ScriptedStream();
    s.push({ kind: "activity" });
    h.transport.streams.push(s);
    await waitFor(() => h.transport.streams.length === 0, 5_000);
    const polls = h.transport.configCalls.length;
    await new Promise((r) => setTimeout(r, 200));
    expect(h.transport.configCalls.length).toBe(polls);
  });

  it("không xác nhận tươi quá hạn ⇒ STALE một lần, cache và trackedFlags giữ nguyên; tươi lại ⇒ fresh", async () => {
    const h = harness({ staleAfterMs: 80, pollingIntervalMs: 10_000 });
    h.transport.configs.push({
      kind: "ok",
      body: configBody(1, [flag("a")], ["a"]),
      etag: '"1"',
    });
    const s = new ScriptedStream();
    h.transport.streams.push(s);
    const tracked = h.store.trackedFlags;
    h.sync.start();
    await waitFor(() => h.log.includes("stale"), 2_000);
    expect(h.sync.isStale).toBe(true);
    expect(h.store.configVersion).toBe(1);
    expect([...h.store.trackedFlags]).toEqual(["a"]);
    expect(h.store.trackedFlags).toBe(tracked); // cùng một Set

    s.push({ kind: "activity" }); // nhịp tim
    await waitFor(() => h.log.includes("fresh"));
    expect(h.log.filter((l) => l === "stale")).toHaveLength(1);
  });

  it("kết nối nửa mở (không một byte nào) ⇒ watchdog huỷ, đếm là hỏng, nối lại", async () => {
    const h = harness({ heartbeatTimeoutMs: 60 });
    h.transport.configs.push({
      kind: "ok",
      body: configBody(1, [flag("a")]),
      etag: '"1"',
    });
    h.transport.streams.push(new ScriptedStream(), new ScriptedStream());
    h.sync.start();
    await waitFor(() => h.transport.streamCalls.length >= 2, 2_000);
    expect(h.transport.streamCalls[1]).toBe(1);
  });
});

describe("401 — khoá bị thu hồi", () => {
  it("ERROR một lần, thôi stream, thử /sdk/config theo chu kỳ; được lại ⇒ authorized", async () => {
    const h = harness({ pollingIntervalMs: 30 });
    h.transport.configs.push({
      kind: "ok",
      body: configBody(1, [flag("a")]),
      etag: '"1"',
    });
    h.transport.streams.push({ kind: "unauthorized" });
    h.transport.configs.push(
      { kind: "unauthorized" },
      { kind: "unauthorized" },
    );
    h.transport.defaultConfig = { kind: "not-modified" };
    h.sync.start();
    await waitFor(() => h.log.includes("unauthorized"));
    expect(h.sync.isStale).toBe(true);
    await waitFor(() => h.log.includes("authorized"), 2_000);
    expect(h.log.filter((l) => l === "unauthorized")).toHaveLength(1);
  });

  it("polling không đè bằng version CŨ hơn cái stream đã áp", async () => {
    const h = harness({ pollingIntervalMs: 20 });
    h.transport.configs.push({
      kind: "ok",
      body: configBody(5, [flag("a")]),
      etag: '"5"',
    });
    h.transport.streams.push({ kind: "unauthorized" });
    h.transport.configs.push({
      kind: "ok",
      body: configBody(3, [flag("old")]),
      etag: '"3"',
    });
    h.sync.start();
    await waitFor(() => h.log.includes("authorized"), 2_000);
    expect(h.store.configVersion).toBe(5);
  });
});

describe("QA code Plan #21 — hồi quy", () => {
  it("proxy trả header rồi giữ mọi byte ⇒ vẫn đếm hỏng và rơi về polling (bộ đếm chỉ về 0 khi có byte)", async () => {
    const h = harness({ heartbeatTimeoutMs: 30 });
    h.transport.configs.push({
      kind: "ok",
      body: configBody(1, [flag("a")]),
      etag: '"1"',
    });
    h.transport.defaultConfig = { kind: "not-modified" };
    for (let i = 0; i < 10; i += 1)
      h.transport.streams.push(new ScriptedStream());
    h.sync.start();
    await waitFor(() => h.transport.configCalls.length >= 2, 3_000);
    expect(h.log.some((l) => l.startsWith("diag:3 lần stream hỏng"))).toBe(
      true,
    );
  });

  it("stream đóng NGAY không một byte ⇒ tính là hỏng (không thành vòng nối lại nóng)", async () => {
    const h = harness();
    h.transport.configs.push({
      kind: "ok",
      body: configBody(1, [flag("a")]),
      etag: '"1"',
    });
    h.transport.defaultConfig = { kind: "not-modified" };
    for (let i = 0; i < 5; i += 1) {
      const s = new ScriptedStream();
      s.end();
      h.transport.streams.push(s);
    }
    h.sync.start();
    await waitFor(() => h.transport.configCalls.length >= 2, 3_000);
    // 5 ms × 2^k có jitter: vài lần mở, không phải hàng nghìn
    expect(h.transport.streamCalls.length).toBeLessThan(10);
  });

  it("stream kết thúc sạch sau `retry:` ⇒ nối lại SAU `retry:`, không ngay lập tức", async () => {
    const h = harness();
    h.transport.configs.push({
      kind: "ok",
      body: configBody(1, [flag("a")]),
      etag: '"1"',
    });
    const s = new ScriptedStream();
    h.transport.streams.push(s, new ScriptedStream());
    h.sync.start();
    await waitFor(() => h.transport.streamCalls.length === 1);
    s.push({ kind: "retry", ms: 250 });
    s.end();
    const ended = Date.now();
    await waitFor(() => h.transport.streamCalls.length === 2, 3_000);
    expect(Date.now() - ended).toBeGreaterThanOrEqual(240);
    expect(h.transport.streamCalls[1]).toBe(1);
  });

  it("`Retry-After` là sàn — jitter không kéo lần thử lại sớm hơn", async () => {
    const h = harness({ random: () => 0 });
    h.transport.configs.push({
      kind: "ok",
      body: configBody(1, [flag("a")]),
      etag: '"1"',
    });
    h.transport.streams.push(
      { kind: "unavailable", retryAfterMs: 250 },
      new ScriptedStream(),
    );
    h.sync.start();
    await waitFor(() => h.transport.streamCalls.length === 1);
    const refused = Date.now();
    await waitFor(() => h.transport.streamCalls.length === 2, 3_000);
    expect(Date.now() - refused).toBeGreaterThanOrEqual(240);
  });

  it("`/sdk/config` treo ⇒ quá hạn riêng, stream không con trỏ vẫn bootstrap được", async () => {
    const h = harness({ requestTimeoutMs: 50 });
    h.transport.configs.push("hang");
    const s = new ScriptedStream();
    h.transport.streams.push(s);
    h.sync.start();
    await waitFor(() => h.transport.streamCalls.length === 1, 2_000);
    expect(h.transport.streamCalls[0]).toBeUndefined();
    s.event("snapshot", configBody(3, [flag("a")]));
    await waitFor(() => h.log.includes("first"));
  });

  it("đang 401 thì không báo STALE chồng lên (trạng thái công bố là ERROR)", async () => {
    const h = harness({ staleAfterMs: 40, pollingIntervalMs: 20 });
    h.transport.configs.push({
      kind: "ok",
      body: configBody(1, [flag("a")]),
      etag: '"1"',
    });
    h.transport.streams.push({ kind: "unauthorized" });
    h.transport.defaultConfig = { kind: "unauthorized" };
    h.sync.start();
    await waitFor(() => h.log.includes("unauthorized"));
    await new Promise((r) => setTimeout(r, 200));
    expect(h.log).not.toContain("stale");
    expect(h.sync.isStale).toBe(true);
  });

  it("snapshot hash lệch ⇒ vẫn thay cache (server là sự thật) nhưng báo chẩn đoán", async () => {
    const h = harness();
    h.transport.configs.push({
      kind: "ok",
      body: { ...configBody(1, [flag("a")]), configHash: "0".repeat(64) },
      etag: '"1"',
    });
    h.transport.streams.push(new ScriptedStream());
    h.sync.start();
    await waitFor(() => h.log.includes("first"));
    expect(h.log.some((l) => l.startsWith("diag:hash của snapshot"))).toBe(
      true,
    );
  });
});
