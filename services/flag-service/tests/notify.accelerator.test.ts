import { EventEmitter } from "node:events";
import type { SessionClient } from "@udp/db";
import {
  CONFIG_CHANGE_CHANNEL,
  formatConfigChangeNotice,
} from "@udp/shared-types/change-feed";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createNotifyAccelerator,
  type IdentityVerdict,
  type NotifyTiming,
} from "../src/changefeed/notify.accelerator.js";

/**
 * Tầng 3 trên một client GIẢ, hình dạng sự kiện chép từ phép đo thật với `pg`:
 * client chết phát `error`, `error` rồi `end`. Kênh thật được thử ở
 * `packages/db/tests/session-client.test.ts` và `tier3.integration.test.ts`.
 *
 * Đồng hồ giả: backoff, jitter và ping là thời gian, và chờ thời gian thật để
 * kiểm "30 giây" là loại test người ta sẽ tắt.
 */

const HELD = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OTHER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

const TIMING: NotifyTiming = {
  reconnectInitialMs: 1_000,
  reconnectMaxMs: 30_000,
  healthCheckMs: 60_000,
  healthCheckTimeoutMs: 5_000,
  identityTimeoutMs: 5_000,
  stopTimeoutMs: 1_000,
};

interface Behavior {
  role?: string;
  connectFails?: boolean;
  /** `connect` treo tới khi test gọi `unhang()` */
  hang?: boolean;
  pingFails?: boolean;
}

class FakeClient implements SessionClient {
  readonly listening: string[] = [];
  closes = 0;
  private readonly behavior: Behavior;
  private readonly bus = new EventEmitter();
  private ended = false;
  private release: (() => void) | undefined;

  constructor(behavior: Behavior) {
    this.behavior = behavior;
  }

  async connect(): Promise<void> {
    if (this.behavior.hang === true) {
      await new Promise<void>((resolve) => {
        this.release = resolve;
      });
    }
    // Như `pg`: client bị đóng trong lúc đang nối thì lần nối đó hỏng
    if (this.ended) throw new Error("Connection terminated");
    if (this.behavior.connectFails === true) throw new Error("ECONNREFUSED");
  }

  currentUser(): Promise<string> {
    return Promise.resolve(this.behavior.role ?? "udp_s2");
  }

  listen(channel: string): Promise<void> {
    this.listening.push(channel);
    return Promise.resolve();
  }

  ping(): Promise<void> {
    return this.behavior.pingFails === true
      ? Promise.reject(new Error("Ping quá 5000ms — đã huỷ kết nối"))
      : Promise.resolve();
  }

  onNotification(
    handler: (channel: string, payload: string | undefined) => void,
  ): void {
    this.bus.on("notification", handler);
  }

  onError(handler: (err: Error) => void): void {
    this.bus.on("error", handler);
  }

  onceEnd(handler: () => void): void {
    this.bus.once("end", handler);
  }

  close(): Promise<void> {
    this.closes += 1;
    this.end();
    return Promise.resolve();
  }

  // ---- điều khiển từ test ------------------------------------------------

  notify(channel: string, payload: string | undefined): void {
    this.bus.emit("notification", channel, payload);
  }

  /** Đúng chuỗi đã đo khi backend bị `pg_terminate_backend`: error, error, end */
  die(): void {
    this.bus.emit(
      "error",
      new Error("terminating connection due to administrator command"),
    );
    this.bus.emit("error", new Error("Connection terminated unexpectedly"));
    this.end();
  }

  /** Lỗi mà KHÔNG kèm `end` */
  fail(): void {
    this.bus.emit("error", new Error("lỗi lẻ"));
  }

  unhang(): void {
    this.release?.();
  }

  private end(): void {
    if (this.ended) return;
    this.ended = true;
    this.bus.emit("end");
  }
}

function rig(
  behaviors: Behavior[] = [],
  options: { random?: () => number; holds?: (id: string) => boolean } = {},
) {
  const clients: FakeClient[] = [];
  let wakes = 0;
  const accelerator = createNotifyAccelerator({
    connect: () => {
      // Hết danh sách thì mọi client sau cư xử như client cuối cùng
      const client = new FakeClient(
        behaviors[clients.length] ?? behaviors.at(-1) ?? {},
      );
      clients.push(client);
      return client;
    },
    expectedRole: "udp_s2",
    holds: options.holds ?? ((id) => id === HELD),
    wake: () => {
      wakes += 1;
    },
    timing: TIMING,
    // random = 1 ⇒ chờ trọn khoảng backoff: số trong test là số chính xác
    random: options.random ?? (() => 1),
  });
  return { accelerator, clients, wakes: () => wakes };
}

const nth = (clients: FakeClient[], i: number): FakeClient => {
  const client = clients[i];
  if (client === undefined) throw new Error(`Chưa có client thứ ${String(i)}`);
  return client;
};

const noticeFor = (environmentId: string): string =>
  formatConfigChangeNotice({ environmentId, configVersion: 9 });

const flush = () => vi.advanceTimersByTimeAsync(0);

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("tầng 3 — nối và nghe", () => {
  it("nối xong: LISTEN đúng kênh, đánh thức MỘT lần để phủ khoảng kênh vắng", async () => {
    const r = rig();
    r.accelerator.start();
    r.accelerator.start(); // gọi hai lần không mở hai kênh
    await flush();

    expect(r.clients).toHaveLength(1);
    expect(nth(r.clients, 0).listening).toEqual([CONFIG_CHANGE_CHANNEL]);
    expect(r.wakes()).toBe(1);
    await r.accelerator.stop();
  });

  it("chỉ notice hợp lệ của environment đang giữ mới đánh thức", async () => {
    const r = rig();
    r.accelerator.start();
    await flush();
    const client = nth(r.clients, 0);
    const before = r.wakes();

    client.notify(CONFIG_CHANGE_CHANNEL, noticeFor(HELD));
    expect(r.wakes()).toBe(before + 1);

    client.notify(CONFIG_CHANGE_CHANNEL, noticeFor(OTHER));
    client.notify("kenh_khac", noticeFor(HELD));
    client.notify(CONFIG_CHANGE_CHANNEL, "không phải JSON");
    client.notify(CONFIG_CHANGE_CHANNEL, undefined);
    expect(r.wakes()).toBe(before + 1);
    await r.accelerator.stop();
  });

  it("holds ném cũng không thoát ra khỏi listener của pg", async () => {
    const r = rig([], {
      holds: () => {
        throw new Error("hỏng");
      },
    });
    r.accelerator.start();
    await flush();

    expect(() => {
      nth(r.clients, 0).notify(CONFIG_CHANGE_CHANNEL, noticeFor(HELD));
    }).not.toThrow();
    await r.accelerator.stop();
  });
});

describe("tầng 3 — nối lại", () => {
  it("client chết phát error, error, end ⇒ nối lại ĐÚNG MỘT lần, sau backoff", async () => {
    const r = rig();
    r.accelerator.start();
    await flush();

    nth(r.clients, 0).die();
    await vi.advanceTimersByTimeAsync(TIMING.reconnectInitialMs - 1);
    expect(r.clients).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(1);
    expect(r.clients).toHaveLength(2);
    expect(nth(r.clients, 1).listening).toEqual([CONFIG_CHANGE_CHANNEL]);
    // Nối lại xong cũng đánh thức — notice lúc kênh vắng đã mất
    expect(r.wakes()).toBe(2);

    // Hai lần `error` không đẻ thêm client nào, kể cả rất lâu sau
    await vi.advanceTimersByTimeAsync(10 * TIMING.reconnectMaxMs);
    expect(r.clients).toHaveLength(2);
    await r.accelerator.stop();
  });

  it("error mà KHÔNG có end ⇒ không nối lại; kết nối zombie do ping bắt", async () => {
    const r = rig([{ pingFails: true }, {}]);
    r.accelerator.start();
    await flush();

    nth(r.clients, 0).fail();
    nth(r.clients, 0).fail();
    await vi.advanceTimersByTimeAsync(TIMING.healthCheckMs - 1);
    expect(r.clients).toHaveLength(1);

    // Ping hỏng ⇒ đóng ⇒ end ⇒ nối lại theo backoff
    await vi.advanceTimersByTimeAsync(1);
    expect(nth(r.clients, 0).closes).toBe(1);
    await vi.advanceTimersByTimeAsync(TIMING.reconnectInitialMs);
    expect(r.clients).toHaveLength(2);
    await r.accelerator.stop();
  });

  it("nối hỏng liên tiếp ⇒ backoff nhân đôi, chạm trần reconnectMaxMs", async () => {
    const r = rig([{ connectFails: true }]);
    r.accelerator.start();
    await flush();

    const delays = [1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000];
    for (const [i, delay] of delays.entries()) {
      await vi.advanceTimersByTimeAsync(delay - 1);
      expect(r.clients, `lần nối thứ ${String(i + 2)} tới sớm`).toHaveLength(
        i + 1,
      );
      await vi.advanceTimersByTimeAsync(1);
      expect(r.clients, `lần nối thứ ${String(i + 2)} không tới`).toHaveLength(
        i + 2,
      );
    }
    expect(r.wakes()).toBe(0);
    await r.accelerator.stop();
  });

  it("jitter: random = 0 ⇒ chỉ chờ nửa khoảng backoff", async () => {
    const r = rig([{ connectFails: true }], { random: () => 0 });
    r.accelerator.start();
    await flush();

    await vi.advanceTimersByTimeAsync(TIMING.reconnectInitialMs / 2 - 1);
    expect(r.clients).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(r.clients).toHaveLength(2);
    await r.accelerator.stop();
  });

  it("sống trọn một chu kỳ ping thì backoff về lại mức đầu", async () => {
    const r = rig([{ connectFails: true }, { connectFails: true }, {}]);
    r.accelerator.start();
    await flush();
    await vi.advanceTimersByTimeAsync(1_000); // client thứ hai — hỏng
    await vi.advanceTimersByTimeAsync(2_000); // client thứ ba — khoẻ
    expect(r.clients).toHaveLength(3);

    await vi.advanceTimersByTimeAsync(TIMING.healthCheckMs); // một ping thành công
    nth(r.clients, 2).die();
    await vi.advanceTimersByTimeAsync(TIMING.reconnectInitialMs);
    expect(r.clients).toHaveLength(4);
    await r.accelerator.stop();
  });

  it("sai role ⇒ không LISTEN, không đánh thức, không bao giờ nối lại", async () => {
    const r = rig([{ role: "postgres" }]);
    r.accelerator.start();
    await flush();

    expect(nth(r.clients, 0).listening).toEqual([]);
    expect(nth(r.clients, 0).closes).toBe(1);
    await vi.advanceTimersByTimeAsync(10 * TIMING.reconnectMaxMs);
    expect(r.clients).toHaveLength(1);
    expect(r.wakes()).toBe(0);
  });
});

describe("tầng 3 — dừng", () => {
  it("stop() đóng client; sau đó không còn timer nào và không nối lại", async () => {
    const r = rig();
    r.accelerator.start();
    await flush();
    await r.accelerator.stop();

    expect(nth(r.clients, 0).closes).toBeGreaterThanOrEqual(1);
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(10 * TIMING.reconnectMaxMs);
    expect(r.clients).toHaveLength(1);
  });

  it("stop() giữa lúc đang nối ⇒ client đó không LISTEN, không đánh thức", async () => {
    const r = rig([{ hang: true }]);
    r.accelerator.start();
    await flush();

    const stopping = r.accelerator.stop();
    nth(r.clients, 0).unhang();
    await stopping;
    await flush();

    expect(nth(r.clients, 0).listening).toEqual([]);
    expect(r.wakes()).toBe(0);
    await vi.advanceTimersByTimeAsync(10 * TIMING.reconnectMaxMs);
    expect(r.clients).toHaveLength(1);
  });

  it("stop() lúc đang chờ nối lại ⇒ huỷ luôn lịch nối lại", async () => {
    const r = rig([{ connectFails: true }]);
    r.accelerator.start();
    await flush();
    await r.accelerator.stop();

    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(10 * TIMING.reconnectMaxMs);
    expect(r.clients).toHaveLength(1);
  });
});

describe("tầng 3 — verifyIdentity lúc khởi động", () => {
  const cases: [string, Behavior, IdentityVerdict | { kind: string }][] = [
    ["đúng role", {}, { kind: "ok" }],
    [
      "sai role",
      { role: "postgres" },
      { kind: "wrong-role", actual: "postgres" },
    ],
    ["không nối được", { connectFails: true }, { kind: "unreachable" }],
  ];

  it.each(cases)(
    "%s ⇒ đúng phán quyết, và LUÔN đóng client",
    async (_label, behavior, verdict) => {
      const r = rig([behavior]);
      await expect(r.accelerator.verifyIdentity()).resolves.toMatchObject(
        verdict,
      );
      expect(r.clients).toHaveLength(1);
      expect(nth(r.clients, 0).closes).toBe(1);
      // Chỉ là phép thử — không bật kênh, không đánh thức
      expect(nth(r.clients, 0).listening).toEqual([]);
      expect(r.wakes()).toBe(0);
    },
  );
});
