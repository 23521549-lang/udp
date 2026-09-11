import { EventEmitter } from "node:events";
import type { SnapshotFlag } from "@udp/flag-evaluator";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ResolvedSdkKey } from "../src/auth/sdk-key.guard.js";
import type {
  ChangeRecord,
  EnvironmentState,
} from "../src/changefeed/change-feed.interface.js";
import type { ConfigChange } from "../src/changefeed/change-events.js";
import type { ConfigEntry } from "../src/changefeed/snapshot.cache.js";
import { sdkConfigBody } from "../src/sdk/config-body.js";
import {
  createSseHub,
  type SseLimits,
  type StreamResponse,
} from "../src/sdk/sse.manager.js";

/**
 * Luật §6.3 của hub SSE trên `res` GIẢ và đồng hồ giả.
 *
 * Mỗi test ở đây canh một câu của hợp đồng mà test tích hợp khó dựng lại theo ý
 * muốn: con trỏ đi trước replica, restore, backlog, khoá thu hồi giữa chừng, sự
 * kiện tới trễ. Đường thật qua HTTP ở `sdk-stream.integration.test.ts`.
 */

const ENV = "11111111-1111-4111-8111-111111111111";
const KEY: ResolvedSdkKey = {
  id: "key-1",
  environmentId: ENV,
  keyType: "SERVER",
};
const KEY2: ResolvedSdkKey = {
  id: "key-2",
  environmentId: ENV,
  keyType: "SERVER",
};

const LIMITS: SseLimits = {
  heartbeatMs: 20_000,
  revocationCheckMs: 5_000,
  retryMs: { min: 1_000, max: 10_000 },
  maxBacklogBytesPerStream: 1_000,
  maxBacklogBytesTotal: 1_000,
  maxStreamsPerKey: 2,
  closeGraceMs: 1_000,
};

const flag = (key: string, enabled: boolean): SnapshotFlag => ({
  key,
  type: "BOOLEAN",
  isEnabled: enabled,
  stickinessAttribute: "targetingKey",
  variants: { on: true, off: false },
  defaultVariantKey: "off",
  rules: [],
});

const entry = (
  version: number,
  flags: SnapshotFlag[],
  hash = `h${String(version)}`,
): ConfigEntry => ({
  environmentId: ENV,
  keyType: "SERVER",
  environmentName: "dev",
  configVersion: version,
  configHash: hash,
  snapshot: { flags, segments: [], trackedFlags: [] },
});

const record = (configVersion: number, f: SnapshotFlag): ChangeRecord => ({
  configVersion,
  changeType: "flag.updated",
  payload: JSON.parse(JSON.stringify({ flag: f })) as ChangeRecord["payload"],
});

const delta = (
  previous: ConfigEntry,
  next: ConfigEntry,
  records: ChangeRecord[],
): ConfigChange => ({ kind: "delta", previous, next, records });

const replaced = (previous: ConfigEntry, next: ConfigEntry): ConfigChange => ({
  kind: "snapshot",
  previous,
  next,
});

interface Frame {
  id?: string;
  event?: string;
  data?: string;
  retry?: number;
  comment?: boolean;
}

class FakeResponse extends EventEmitter implements StreamResponse {
  statusCode = 0;
  readonly headers = new Map<string, string>();
  readonly raw: Buffer[] = [];
  flushed = false;
  writableLength = 0;
  writableEnded = false;
  destroyed = false;

  setHeader(name: string, value: string): this {
    this.headers.set(name.toLowerCase(), value);
    return this;
  }

  flushHeaders(): void {
    this.flushed = true;
  }

  write(chunk: Buffer): boolean {
    // Như `http`: ghi sau end/destroy là lỗi — hub không bao giờ được làm vậy
    if (this.writableEnded || this.destroyed) {
      throw new Error("ERR_STREAM_WRITE_AFTER_END");
    }
    this.raw.push(chunk);
    return true;
  }

  end(): this {
    this.writableEnded = true;
    this.emit("close");
    return this;
  }

  destroy(): this {
    this.destroyed = true;
    this.emit("close");
    return this;
  }

  /** Client ngắt */
  hangUp(): void {
    this.destroyed = true;
    this.emit("close");
  }

  frames(): Frame[] {
    return Buffer.concat(this.raw)
      .toString()
      .split("\n\n")
      .filter((block) => block.length > 0)
      .map((block) => {
        const frame: Frame = {};
        for (const line of block.split("\n")) {
          if (line.startsWith(":")) {
            frame.comment = true;
            continue;
          }
          const at = line.indexOf(": ");
          const field = line.slice(0, at);
          const value = line.slice(at + 2);
          if (field === "id") frame.id = value;
          else if (field === "event") frame.event = value;
          else if (field === "data") frame.data = value;
          else if (field === "retry") frame.retry = Number(value);
        }
        return frame;
      });
  }

  events(): { event: string; id: number; data: unknown }[] {
    return this.frames().flatMap((f) =>
      f.event === undefined
        ? []
        : [
            {
              event: f.event,
              id: Number(f.id),
              data: JSON.parse(f.data ?? "null"),
            },
          ],
    );
  }

  /** `[event, id]` — đủ để đọc thứ tự và loại */
  seen(): [string, number][] {
    return this.events().map((e) => [e.event, e.id]);
  }
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function rig() {
  const state = {
    current: entry(5, [flag("a", false)]),
    db: new Map<string, EnvironmentState>(),
    active: new Set(["key-1", "key-2"]),
    keysDown: false,
    wakes: 0,
    keyChecks: 0,
    /** Treo `cache.get` tới khi mở */
    gate: undefined as Promise<void> | undefined,
    /** Treo lần kiểm khoá tới khi mở */
    hold: undefined as Promise<void> | undefined,
  };

  const hub = createSseHub({
    cache: {
      get: async () => {
        if (state.gate !== undefined) await state.gate;
        return state.current;
      },
      peek: () => state.current,
    },
    statesOf: (ids) =>
      Promise.resolve(
        new Map(
          ids.flatMap((id) => {
            const truth = state.db.get(id);
            return truth === undefined ? [] : [[id, truth] as const];
          }),
        ),
      ),
    wake: () => {
      state.wakes += 1;
    },
    activeKeysAmong: async (ids) => {
      state.keyChecks += 1;
      if (state.hold !== undefined) await state.hold;
      if (state.keysDown) throw new Error("database chớp");
      return new Set(ids.filter((id) => state.active.has(id)));
    },
    limits: LIMITS,
    random: () => 0.5,
  });

  return {
    hub,
    state,
    async open(cursor?: number, key: ResolvedSdkKey = KEY) {
      const res = new FakeResponse();
      const result = await hub.open(res, key, cursor);
      return { res, result };
    },
    /** Như watcher: cache đổi TRƯỚC, rồi mới phát */
    publish(change: ConfigChange) {
      state.current = change.next;
      hub.onChange(change);
    },
  };
}

const flush = () => vi.advanceTimersByTimeAsync(0);

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("mở stream — luật con trỏ §6.3", () => {
  it("không con trỏ: header chống đệm, flush ngay, retry: rồi snapshot = body /sdk/config", async () => {
    const r = rig();
    const { res, result } = await r.open();

    expect(result).toEqual({ kind: "accepted" });
    expect(res.statusCode).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/event-stream");
    expect(res.headers.get("x-accel-buffering")).toBe("no");
    expect(res.flushed).toBe(true);
    expect(res.frames()[0]?.retry).toBe(5_500);
    expect(res.events()).toEqual([
      { event: "snapshot", id: 5, data: sdkConfigBody(r.state.current) },
    ]);
  });

  it("con trỏ nhỏ hơn ⇒ snapshot; bằng ⇒ chỉ header", async () => {
    const r = rig();
    expect((await r.open(3)).res.seen()).toEqual([["snapshot", 5]]);

    const equal = await r.open(5);
    expect(equal.res.flushed).toBe(true);
    expect(equal.res.seen()).toEqual([]);
  });

  it("con trỏ đi TRƯỚC, database ≥ con trỏ ⇒ chờ; không bao giờ gửi thứ cũ hơn con trỏ", async () => {
    const r = rig();
    r.state.db.set(ENV, { configVersion: 7, configHash: "h7" });
    const { res } = await r.open(7);
    expect(res.seen()).toEqual([]);
    expect(r.state.wakes).toBe(1);

    const e5 = r.state.current;
    const e6 = entry(6, [flag("a", true)]);
    r.publish(delta(e5, e6, [record(6, flag("a", true))]));
    await flush();
    expect(res.seen(), "replica đang đuổi mà đã kéo SDK lùi").toEqual([]);

    const e7 = entry(7, [flag("a", false)]);
    r.publish(delta(e6, e7, [record(7, flag("a", false))]));
    await flush();
    expect(res.seen(), "đuổi kịp ĐÚNG con trỏ — SDK đã có thứ này").toEqual([]);

    const e8 = entry(8, [flag("a", true)]);
    r.publish(delta(e7, e8, [record(8, flag("a", true))]));
    await flush();
    expect(res.seen()).toEqual([["flag_changed", 8]]);
  });

  it("con trỏ đi TRƯỚC, database DƯỚI con trỏ và cache khớp database ⇒ snapshot ngay (restore)", async () => {
    const r = rig();
    r.state.db.set(ENV, { configVersion: 5, configHash: "h5" });
    const { res } = await r.open(9);
    expect(res.seen()).toEqual([["snapshot", 5]]);
  });

  it("restore mà cache chưa theo kịp ⇒ đánh thức; snapshot THẤP hơn tới qua watcher vẫn được gửi", async () => {
    const r = rig();
    r.state.db.set(ENV, { configVersion: 3, configHash: "h3" });
    const { res } = await r.open(9);
    expect(res.seen()).toEqual([]);
    expect(r.state.wakes).toBe(1);

    r.publish(replaced(r.state.current, entry(3, [flag("a", true)])));
    await flush();
    expect(res.seen()).toEqual([["snapshot", 3]]);
  });
});

describe("đẩy thay đổi", () => {
  it("delta liền mạch ⇒ flag_changed đúng hình dạng §6.3", async () => {
    const r = rig();
    const { res } = await r.open(5);
    r.publish(
      delta(r.state.current, entry(6, [flag("a", true)]), [
        record(6, flag("a", true)),
      ]),
    );
    await flush();

    expect(res.events()).toEqual([
      {
        event: "flag_changed",
        id: 6,
        data: {
          fromVersion: 5,
          toVersion: 6,
          configHash: "h6",
          changes: [{ configVersion: 6, kind: "flag", flag: flag("a", true) }],
        },
      },
    ]);
  });

  it("cùng version nhưng KHÁC hash ⇒ snapshot, không phải delta (I15c)", async () => {
    /**
     * SDK giữ `(5, h5)`; delta xuất phát từ `(5, h5-khac)` — cùng SỐ, khác NỘI
     * DUNG. Áp delta lên thứ SDK đang giữ cho ra một thứ không bao giờ khớp
     * `configHash`. Chỉ so version ở đây là để lọt đúng ca đó.
     */
    const r = rig();
    const { res } = await r.open(5);
    const other = entry(5, [flag("a", true)], "h5-khac");
    r.publish(
      delta(other, entry(6, [flag("a", false)]), [record(6, flag("a", false))]),
    );
    await flush();
    expect(res.seen()).toEqual([["snapshot", 6]]);
  });

  it("delta không xuất phát từ version của stream ⇒ snapshot", async () => {
    const r = rig();
    const { res } = await r.open(5);
    r.publish(
      delta(entry(6, [flag("a", true)]), entry(7, [flag("a", false)]), [
        record(7, flag("a", false)),
      ]),
    );
    await flush();
    expect(res.seen()).toEqual([["snapshot", 7]]);
  });

  it("(version, hash) trùng thứ stream đang giữ ⇒ không gửi gì", async () => {
    const r = rig();
    const { res } = await r.open(5);
    r.publish(replaced(entry(4, []), entry(5, [flag("a", false)])));
    await flush();
    expect(res.seen()).toEqual([]);
  });

  it("một event dựng MỘT lần cho mọi stream", async () => {
    const r = rig();
    const a = await r.open(5);
    const b = await r.open(5, KEY2);
    r.publish(
      delta(r.state.current, entry(6, [flag("a", true)]), [
        record(6, flag("a", true)),
      ]),
    );
    await flush();
    expect(a.res.raw.at(-1)).toBeDefined();
    expect(a.res.raw.at(-1)).toBe(b.res.raw.at(-1));
  });

  it("sự kiện tới TRƯỚC khi stream mở nhưng giao SAU ⇒ không kéo stream lùi", async () => {
    const r = rig();
    const first = await r.open(5);
    const gate = deferred();
    r.state.hold = gate.promise;

    const e5 = r.state.current;
    const e6 = entry(6, [flag("a", true)]);
    const e7 = entry(7, [flag("a", false)]);
    r.publish(delta(e5, e6, [record(6, flag("a", true))]));
    r.publish(delta(e6, e7, [record(7, flag("a", false))]));

    // Mở ở 7 trong lúc hai sự kiện còn chờ kiểm khoá
    const late = await r.open(7, KEY2);
    r.state.hold = undefined;
    gate.resolve();
    await flush();

    expect(late.res.seen(), "sự kiện cũ đã kéo stream mới lùi").toEqual([]);
    expect(first.res.seen()).toEqual([
      ["flag_changed", 6],
      ["flag_changed", 7],
    ]);
  });

  it("sự kiện của environment không ai nghe ⇒ không tốn một lần kiểm khoá", async () => {
    const r = rig();
    r.publish(replaced(r.state.current, entry(6, [])));
    await flush();
    expect(r.state.keyChecks).toBe(0);
  });
});

describe("thu hồi khoá (§12 T7)", () => {
  it("khoá bị thu hồi ⇒ không đẩy gì nữa, và stream đóng trong một chu kỳ kiểm", async () => {
    const r = rig();
    const { res } = await r.open(5);
    r.state.active.delete("key-1");

    r.publish(
      delta(r.state.current, entry(6, [flag("a", true)]), [
        record(6, flag("a", true)),
      ]),
    );
    await flush();
    expect(res.seen()).toEqual([]);
    expect(res.destroyed).toBe(false);

    await vi.advanceTimersByTimeAsync(LIMITS.revocationCheckMs);
    expect(res.destroyed).toBe(true);
    expect(r.hub.size()).toBe(0);
  });

  it("không kiểm được khoá ⇒ bỏ lượt đẩy; vòng kiểm sau bù bằng snapshot", async () => {
    const r = rig();
    const { res } = await r.open(5);
    r.state.keysDown = true;

    r.publish(
      delta(r.state.current, entry(6, [flag("a", true)]), [
        record(6, flag("a", true)),
      ]),
    );
    await flush();
    expect(res.seen()).toEqual([]);

    r.state.keysDown = false;
    await vi.advanceTimersByTimeAsync(LIMITS.revocationCheckMs);
    expect(res.seen()).toEqual([["snapshot", 6]]);
  });
});

describe("hạn mức và vòng đời", () => {
  it("trần stream mỗi khoá: giữ chỗ đồng bộ; vượt ⇒ 429 kèm Retry-After; trả chỗ khi đóng", async () => {
    const r = rig();
    const [a, , c] = await Promise.all([r.open(), r.open(), r.open()]);

    expect(c.result).toEqual({
      kind: "rejected",
      status: 429,
      retryAfterSeconds: 6,
    });
    expect(c.res.raw).toEqual([]);

    a.res.hangUp();
    expect((await r.open()).result.kind).toBe("accepted");
  });

  it("client ngắt trong lúc chờ cache ⇒ không đăng ký, và trả chỗ", async () => {
    const r = rig();
    const gate = deferred();
    r.state.gate = gate.promise;

    const res = new FakeResponse();
    const opening = r.hub.open(res, KEY, undefined);
    res.hangUp();
    gate.resolve();
    await opening;
    expect(res.raw).toEqual([]);
    expect(r.hub.size()).toBe(0);

    r.state.gate = undefined;
    const kinds = [(await r.open()).result.kind, (await r.open()).result.kind];
    expect(kinds).toEqual(["accepted", "accepted"]);
  });

  it("backlog một stream vượt trần ⇒ huỷ ở lần ghi kế tiếp, không ghi sau khi huỷ", async () => {
    const r = rig();
    const { res } = await r.open(5);
    res.writableLength = LIMITS.maxBacklogBytesPerStream + 1;

    r.publish(
      delta(r.state.current, entry(6, [flag("a", true)]), [
        record(6, flag("a", true)),
      ]),
    );
    await flush();
    expect(res.destroyed).toBe(true);
    expect(r.hub.size()).toBe(0);

    // Nhịp tim sau đó KHÔNG được ghi lên stream đã huỷ — `FakeResponse` sẽ ném
    await vi.advanceTimersByTimeAsync(LIMITS.heartbeatMs);
  });

  it("snapshot lớn hơn trần vẫn tới được client đọc kịp", async () => {
    const r = rig();
    r.state.current = entry(
      5,
      Array.from({ length: 30 }, (_, i) => flag(`flag-${String(i)}`, true)),
    );
    const { res } = await r.open();
    expect(res.raw.at(-1)?.length).toBeGreaterThan(
      LIMITS.maxBacklogBytesPerStream,
    );
    expect(res.seen()).toEqual([["snapshot", 5]]);
    expect(res.destroyed).toBe(false);
  });

  it("tổng backlog vượt trần ⇒ cắt stream ĐANG kẹt; stream đọc kịp vẫn nhận", async () => {
    const r = rig();
    const slow = await r.open(5);
    const fast = await r.open(5, KEY2);
    slow.res.writableLength = 900; // dưới trần của MỘT stream, nhưng tổng thì vượt

    r.publish(
      delta(r.state.current, entry(6, [flag("a", true)]), [
        record(6, flag("a", true)),
      ]),
    );
    await flush();
    expect(slow.res.destroyed).toBe(true);
    expect(fast.res.seen()).toEqual([["flag_changed", 6]]);
  });

  it("nhịp tim mỗi heartbeatMs; stream đã đóng thì không nhận nữa", async () => {
    const r = rig();
    const { res } = await r.open(5);
    await vi.advanceTimersByTimeAsync(LIMITS.heartbeatMs);
    expect(res.frames().filter((f) => f.comment === true)).toHaveLength(1);

    res.hangUp();
    const before = res.raw.length;
    await vi.advanceTimersByTimeAsync(3 * LIMITS.heartbeatMs);
    expect(res.raw).toHaveLength(before);
  });

  it("closeAll: retry: rồi end cho mọi stream; mở mới ⇒ 503; không còn timer", async () => {
    const r = rig();
    const { res } = await r.open(5);
    r.hub.closeAll();

    expect(res.frames().at(-1)?.retry).toBe(5_500);
    expect(res.writableEnded).toBe(true);
    expect((await r.open()).result).toEqual({
      kind: "rejected",
      status: 503,
      retryAfterSeconds: 6,
    });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("không stream nào ⇒ không truy vấn nền nào", async () => {
    const r = rig();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(r.state.keyChecks).toBe(0);

    const { res } = await r.open(5);
    res.hangUp();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(r.state.keyChecks).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });
});
