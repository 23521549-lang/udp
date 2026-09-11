import {
  configHashOf,
  type Snapshot,
  type SnapshotFlag,
} from "@udp/flag-evaluator";
import { CONFIG_CHANGE_TYPES, type ConfigChangeType } from "@udp/shared-types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ChangeFeed,
  ChangeRecord,
  EnvironmentState,
} from "../src/changefeed/change-feed.interface.js";
import {
  createConfigChangeEvents,
  type ConfigChange,
  type ConfigChangeEvents,
} from "../src/changefeed/change-events.js";
import { verifyHash } from "../src/changefeed/checksum.verifier.js";
import { createCircuitBreaker } from "../src/changefeed/circuit-breaker.js";
import { readCounters, resetCounters } from "../src/changefeed/metrics.js";
import {
  createSnapshotCache,
  type EntryLoader,
} from "../src/changefeed/snapshot.cache.js";
import { createVersionWatcher } from "../src/changefeed/version.watcher.js";

/**
 * Ba nhánh của TẦNG 1, và quy tắc rơi tầng của ADR-05.
 *
 * Không chạm database: change feed là một interface đúng vì lý do này, và cái
 * giá phải trả cho một hợp đồng chỉ đáng nếu ta thực sự dùng nó.
 *
 * Test nặng nhất ở đây là "áp delta chứ KHÔNG lấy snapshot". Nó bắt đúng lỗi mà
 * bản plan đầu mắc phải — "version đổi thì vô hiệu hoá cache" — một câu gộp hai
 * nhánh cuối làm một và làm TẦNG 2 không bao giờ chạy. Hệ thống vẫn đúng, mọi
 * test khác vẫn xanh, chỉ là tầng delta không tồn tại; và phép đo E4 sẽ kết luận
 * sai rằng kiến trúc ba tầng không đáng giá.
 */

const ENV = "11111111-1111-4111-8111-111111111111";

const flag = (key: string, enabled: boolean): SnapshotFlag => ({
  key,
  type: "BOOLEAN",
  isEnabled: enabled,
  stickinessAttribute: "targetingKey",
  variants: { on: true, off: false },
  defaultVariantKey: "off",
  rules: [],
});

const snap = (flags: SnapshotFlag[]): Snapshot => ({
  flags,
  segments: [],
  trackedFlags: [],
});

interface Harness {
  loads: number;
  setStored: (version: number, flags: SnapshotFlag[]) => void;
}

/**
 * Dựng watcher trên một feed giả và một cache THẬT.
 *
 * Cache là bản thật vì single-flight và kỷ luật bộ ba nằm trong nó — thay nó
 * bằng một Map giả là bỏ qua đúng phần khó.
 */
function harness(options: {
  deltaMode: boolean;
  cached: { version: number; flags: SnapshotFlag[] };
  target: EnvironmentState;
  records?: ChangeRecord[];
  events?: ConfigChangeEvents;
}) {
  const stored = {
    version: options.cached.version,
    flags: options.cached.flags,
  };
  const state: Harness = {
    loads: 0,
    setStored: (version, flags) => {
      stored.version = version;
      stored.flags = flags;
    },
  };

  const load: EntryLoader = (environmentId) => {
    state.loads += 1;
    return Promise.resolve({
      environmentId,
      environmentName: "dev",
      configVersion: stored.version,
      configHash: configHashOf(snap(stored.flags)),
      snapshot: snap(stored.flags),
    });
  };

  const feed: ChangeFeed = {
    statesOf: (ids) =>
      Promise.resolve(new Map(ids.map((id) => [id, options.target]))),
    deltasSince: (_environmentId, cursor) =>
      Promise.resolve(
        (options.records ?? []).filter((r) => r.configVersion > cursor),
      ),
  };

  const cache = createSnapshotCache(load);
  const breaker = createCircuitBreaker();
  const watcher = createVersionWatcher({
    feed,
    cache,
    breaker,
    deltaMode: options.deltaMode,
    ...(options.events === undefined ? {} : { events: options.events }),
  });

  return { state, cache, breaker, watcher };
}

const deltaRow = (
  configVersion: number,
  changeType: string,
  f: SnapshotFlag,
): ChangeRecord => ({
  configVersion,
  changeType,
  payload: JSON.parse(JSON.stringify({ flag: f })) as ChangeRecord["payload"],
});

beforeEach(() => {
  resetCounters();
});

describe("TẦNG 1 — ba nhánh của ADR-05", () => {
  it("con trỏ BẰNG version thật: dùng cache, không đọc gì thêm", async () => {
    const h = harness({
      deltaMode: true,
      cached: { version: 7, flags: [flag("a", false)] },
      target: {
        configVersion: 7,
        configHash: configHashOf(snap([flag("a", false)])),
      },
    });

    await h.cache.get(ENV, "SERVER");
    const before = h.state.loads;

    await h.watcher.tick();

    expect(h.state.loads).toBe(before);
    expect(h.cache.peek(ENV, "SERVER")?.configVersion).toBe(7);
  });

  it("con trỏ LÙI so với version thật: lấy snapshot", async () => {
    const h = harness({
      deltaMode: true,
      cached: { version: 7, flags: [flag("a", false)] },
      target: { configVersion: 3, configHash: "" },
    });

    await h.cache.get(ENV, "SERVER");
    h.state.setStored(3, [flag("a", true)]);

    await h.watcher.tick();

    expect(h.cache.peek(ENV, "SERVER")?.configVersion).toBe(3);
  });

  it("con trỏ SAU version thật, chế độ delta: ÁP DELTA, không lấy snapshot", async () => {
    /**
     * Đây là test giữ cho tầng 2 tồn tại. Nếu watcher gộp nhánh này với nhánh
     * "lùi" — tức cứ khác là nạp lại — thì `loads` sẽ tăng, và bản thân dữ liệu
     * vẫn ĐÚNG. Không có phép kiểm nào khác trong repo phân biệt được hai cách
     * cài đặt ấy.
     */
    const after = [flag("a", true)];
    const h = harness({
      deltaMode: true,
      cached: { version: 7, flags: [flag("a", false)] },
      target: { configVersion: 8, configHash: configHashOf(snap(after)) },
      records: [deltaRow(8, "flag.updated", flag("a", true))],
    });

    await h.cache.get(ENV, "SERVER");
    const before = h.state.loads;

    await h.watcher.tick();

    expect(h.state.loads).toBe(before);
    const entry = h.cache.peek(ENV, "SERVER");
    expect(entry?.configVersion).toBe(8);
    expect(entry?.snapshot.flags).toEqual(after);
    expect(readCounters().changefeed_fallback_total).toBe(0);
  });

  it("chế độ snapshot: tầng 2 KHÔNG chạy, và lấy snapshot không bị đếm là rơi tầng", async () => {
    /**
     * `CHANGEFEED_MODE` mặc định là `snapshot`. Ở chế độ đó, lấy snapshot là
     * đường CHÍNH THỨC chứ không phải sự cố — đếm nó vào `changefeed_fallback_total`
     * làm bộ đếm tăng ở mọi thay đổi flag trong cấu hình mặc định, và biến một
     * chỉ số cảnh báo thành tiếng ồn.
     */
    const after = [flag("a", true)];
    const h = harness({
      deltaMode: false,
      cached: { version: 7, flags: [flag("a", false)] },
      target: { configVersion: 8, configHash: configHashOf(snap(after)) },
      records: [deltaRow(8, "flag.updated", flag("a", true))],
    });

    await h.cache.get(ENV, "SERVER");
    const before = h.state.loads;
    h.state.setStored(8, after);

    await h.watcher.tick();

    expect(h.state.loads).toBe(before + 1);
    expect(readCounters().changefeed_fallback_total).toBe(0);
  });
});

describe("quy tắc rơi tầng", () => {
  it("hổng trong chuỗi version: lấy snapshot và đếm là rơi tầng", async () => {
    const after = [flag("a", true)];
    const h = harness({
      deltaMode: true,
      cached: { version: 7, flags: [flag("a", false)] },
      target: { configVersion: 9, configHash: configHashOf(snap(after)) },
      // thiếu version 8 — dòng đó đã bị dọn
      records: [deltaRow(9, "flag.updated", flag("a", true))],
    });

    await h.cache.get(ENV, "SERVER");
    h.state.setStored(9, after);

    await h.watcher.tick();

    expect(h.cache.peek(ENV, "SERVER")?.configVersion).toBe(9);
    expect(readCounters().changefeed_fallback_total).toBe(1);
  });

  it("change_type lạ thì rơi tầng, TUYỆT ĐỐI không ném", async () => {
    /**
     * Từ vựng §2.2 lớn dần — v4.1 vừa thêm `rule.ramped`. Replica chạy phiên bản
     * cũ gặp giá trị mới phải rơi về snapshot chứ không chết: §16 bắt triển khai
     * "replica trước, writer sau", và nhánh này là lưới an toàn khi thứ tự đó bị
     * làm ngược. Một `switch` vét cạn có `default: throw` biến một lần triển khai
     * sai thứ tự thành một replica ngừng cập nhật.
     */
    const UNKNOWN = "flag.renamed";
    expect(CONFIG_CHANGE_TYPES).not.toContain(UNKNOWN);

    const after = [flag("a", true)];
    const h = harness({
      deltaMode: true,
      cached: { version: 7, flags: [flag("a", false)] },
      target: { configVersion: 8, configHash: configHashOf(snap(after)) },
      records: [deltaRow(8, UNKNOWN, flag("a", true))],
    });

    await h.cache.get(ENV, "SERVER");
    h.state.setStored(8, after);

    await expect(h.watcher.tick()).resolves.toBeUndefined();
    expect(readCounters().changefeed_fallback_total).toBe(1);

    expect(h.cache.peek(ENV, "SERVER")?.configVersion).toBe(8);
    expect(h.cache.peek(ENV, "SERVER")?.snapshot.flags).toEqual(after);
  });

  it("delta sai NỘI DUNG nhưng đúng SỐ vẫn bị bắt — đó là lý do config_hash tồn tại", async () => {
    /**
     * I15a nguyên văn: `config_version` là số đếm chứ không phải checksum. Delta
     * dưới đây mang đúng version 8 nhưng nội dung sai, nên chỉ phép so hash bắt
     * được. Không có nó, replica tự tin là đã đồng bộ trong khi đang phục vụ
     * `isEnabled` ngược.
     */
    const truth = [flag("a", true)];
    const h = harness({
      deltaMode: true,
      cached: { version: 7, flags: [flag("a", false)] },
      target: { configVersion: 8, configHash: configHashOf(snap(truth)) },
      records: [deltaRow(8, "flag.updated", flag("a", false))],
    });

    await h.cache.get(ENV, "SERVER");
    h.state.setStored(8, truth);

    await h.watcher.tick();

    expect(readCounters().changefeed_hash_mismatch_total).toBe(1);
    expect(readCounters().changefeed_fallback_total).toBe(1);
    expect(h.cache.peek(ENV, "SERVER")?.snapshot.flags).toEqual(truth);
  });

  it("ba lần rơi tầng liên tiếp thì NGẮT MẠCH — tầng 2 ngừng được hỏi tới", async () => {
    const after = [flag("a", true)];
    const h = harness({
      deltaMode: true,
      cached: { version: 1, flags: [flag("a", false)] },
      target: { configVersion: 99, configHash: configHashOf(snap(after)) },
      // Không có delta nào để áp, nên mỗi vòng đều rơi tầng với lý do "incomplete"
      records: [],
    });

    await h.cache.get(ENV, "SERVER");

    /**
     * Bốn vòng, nhưng chỉ BA lần được đếm.
     *
     * Vòng thứ tư đáng lẽ cũng rơi, nhưng mạch đã ngắt sau vòng thứ ba nên tầng 2
     * không còn được hỏi tới. Đó chính là điều ngắt mạch mua được: một environment
     * có tầng 2 hỏng vĩnh viễn thôi trả tiền cho cả hai tầng ở MỎcI vòng poll.
     */
    for (let i = 0; i < 4; i += 1) {
      h.state.setStored(1, [flag("a", false)]);
      await h.watcher.tick();
    }

    expect(readCounters().changefeed_fallback_total).toBe(3);
    expect(h.breaker.isOpen(ENV)).toBe(true);
  });
});

describe("chống bão snapshot", () => {
  it("nhiều lời gọi đồng thời chỉ tạo ĐÚNG MỘT lần nạp", async () => {
    /**
     * §1.4: "500 SDK cùng phát hiện thay đổi trong cửa sổ 500ms sẽ tạo 500 truy
     * vấn; có cache thì đúng MỘT". Đã đo hình dạng đó trên database thật: 50 lời
     * gọi đồng thời trên pool 5 làm 26/50 chết bằng `P2028` — nên phần tràn
     * không phải chậm hơn, mà là hỏng hẳn.
     */
    let loads = 0;
    const load: EntryLoader = async (environmentId) => {
      loads += 1;
      await new Promise((r) => setTimeout(r, 20));
      return {
        environmentId,
        environmentName: "dev",
        configVersion: 1,
        configHash: configHashOf(snap([])),
        snapshot: snap([]),
      };
    };

    const cache = createSnapshotCache(load);
    const results = await Promise.all(
      Array.from({ length: 500 }, () => cache.get(ENV, "SERVER")),
    );

    expect(loads).toBe(1);
    expect(new Set(results).size).toBe(1);
  });

  it("một lần nạp HỎNG không đầu độc những lời gọi sau", async () => {
    /**
     * Xoá khỏi bản đồ single-flight phải ở `finally`, không phải `then`. Chỉ xoá
     * khi thành công thì promise đã reject nằm lại vĩnh viễn, và environment đó
     * hỏng cho tới lúc restart tiến trình.
     */
    let attempt = 0;
    const load: EntryLoader = (environmentId) => {
      attempt += 1;
      if (attempt === 1) return Promise.reject(new Error("database chớp"));
      return Promise.resolve({
        environmentId,
        environmentName: "dev",
        configVersion: 1,
        configHash: configHashOf(snap([])),
        snapshot: snap([]),
      });
    };

    const cache = createSnapshotCache(load);
    await expect(cache.get(ENV, "SERVER")).rejects.toThrow("database chớp");
    await expect(cache.get(ENV, "SERVER")).resolves.toMatchObject({
      configVersion: 1,
    });
  });
});

describe("cô lập lỗi giữa các environment", () => {
  it("một environment hỏng KHÔNG làm đói những environment còn lại", async () => {
    /**
     * `snapshotOf` ném có chủ đích khi dữ liệu không dựng nổi hình dạng dây —
     * variant mồ côi, `conditions` sai kiểu, flag thiếu variant mặc định. Nếu
     * `tick` không cô lập từng environment, lỗi đó thoát khỏi cả vòng lặp: mọi
     * environment đứng SAU nó bị bỏ qua, và vòng kế tiếp lại gặp đúng nó trước.
     * Chúng đói vĩnh viễn — một flag hỏng ở một project đóng băng cấu hình của
     * mọi project khác trên replica này.
     *
     * `BAD` được nạp vào cache TRƯỚC nên nó đứng đầu thứ tự duyệt của `Map`.
     */
    const BAD = "22222222-2222-4222-8222-222222222222";
    const GOOD = "33333333-3333-4333-8333-333333333333";

    let broken = false;
    const loaded: string[] = [];

    const load: EntryLoader = (environmentId) => {
      if (broken && environmentId === BAD) {
        return Promise.reject(new Error('Flag "x": không có variant mặc định'));
      }
      loaded.push(environmentId);
      return Promise.resolve({
        environmentId,
        environmentName: "dev",
        configVersion: 1,
        configHash: configHashOf(snap([])),
        snapshot: snap([]),
      });
    };

    const cache = createSnapshotCache(load);
    await cache.get(BAD, "SERVER");
    await cache.get(GOOD, "SERVER");
    broken = true;

    const watcher = createVersionWatcher({
      feed: {
        // Cả hai đều đã sang version 2 ⇒ cả hai cần nạp lại
        statesOf: (ids) =>
          Promise.resolve(
            new Map(
              ids.map((id) => [id, { configVersion: 2, configHash: "" }]),
            ),
          ),
        deltasSince: () => Promise.resolve([]),
      },
      cache,
      breaker: createCircuitBreaker(),
      deltaMode: false,
    });

    await expect(watcher.tick()).resolves.toBeUndefined();

    expect(loaded.filter((id) => id === GOOD)).toHaveLength(2);
    expect(loaded.filter((id) => id === BAD)).toHaveLength(1);
  });
});

describe("config_hash rỗng", () => {
  it("là 'CHƯA CÓ MỐC', không phải lệch", () => {
    /**
     * `Environment.config_hash` khai `@default("")`, và đo trên database thật:
     * 6/6 environment hiện có đang mang giá trị đó. Coi nó như một hash để so là
     * lệch 100% ⇒ ba lần liên tiếp là ngắt mạch ⇒ hết 5 phút lại lệch tiếp ⇒ lặp
     * mãi. Một sự cố hoàn toàn tự gây ra, và `changefeed_hash_mismatch_total` sẽ
     * chỉ vào một nguyên nhân không tồn tại.
     */
    expect(verifyHash(snap([]), "")).toBe("no-baseline");
    expect(readCounters().changefeed_hash_mismatch_total).toBe(0);

    expect(verifyHash(snap([]), "a".repeat(64))).toBe("mismatch");
    expect(readCounters().changefeed_hash_mismatch_total).toBe(1);
  });
});

describe("tầng 2 áp được ba change_type của đường ghi rule (Plan #12, Mục 4)", () => {
  it.each([
    "rule.replaced",
    "rule.ramped",
    "envconfig.toggled",
  ] satisfies ConfigChangeType[])(
    "%s: áp delta, KHÔNG rơi về snapshot",
    async (changeType) => {
      /**
       * Thiếu một `case` ở poller thì mọi lần sửa rule đều rơi về snapshot — hệ
       * thống vẫn ĐÚNG, mọi test khác vẫn xanh, chỉ là tầng 2 không tồn tại cho
       * đúng loại thay đổi mà C1 sinh ra nhiều nhất; ba lần liên tiếp là ngắt
       * mạch tầng 2 của environment đó.
       */
      const after = [flag("a", true)];
      const h = harness({
        deltaMode: true,
        cached: { version: 7, flags: [flag("a", false)] },
        target: { configVersion: 8, configHash: configHashOf(snap(after)) },
        records: [deltaRow(8, changeType, flag("a", true))],
      });

      await h.cache.get(ENV, "SERVER");
      const before = h.state.loads;
      await h.watcher.tick();

      expect(h.state.loads).toBe(before);
      expect(h.cache.peek(ENV, "SERVER")?.snapshot.flags).toEqual(after);
      expect(readCounters().changefeed_fallback_total).toBe(0);
    },
  );

  it("payload của rule.ramped mang thêm rolloutSessionId vẫn áp được", async () => {
    const after = [flag("a", true)];
    const h = harness({
      deltaMode: true,
      cached: { version: 7, flags: [flag("a", false)] },
      target: { configVersion: 8, configHash: configHashOf(snap(after)) },
      records: [
        {
          configVersion: 8,
          changeType: "rule.ramped",
          payload: JSON.parse(
            JSON.stringify({
              rolloutSessionId: "0190a1b2-c3d4-4e5f-8a6b-7c8d9e0f1a2b",
              flag: flag("a", true),
            }),
          ) as ChangeRecord["payload"],
        },
      ],
    });

    await h.cache.get(ENV, "SERVER");
    await h.watcher.tick();

    expect(h.cache.peek(ENV, "SERVER")?.configVersion).toBe(8);
    expect(readCounters().changefeed_fallback_total).toBe(0);
  });
});

describe("sự kiện thay đổi cho sdk/ (Plan #13, Mục 4)", () => {
  const listen = (): { events: ConfigChangeEvents; seen: ConfigChange[] } => {
    const events = createConfigChangeEvents();
    const seen: ConfigChange[] = [];
    events.subscribe((change) => {
      seen.push(change);
    });
    return { events, seen };
  };

  it("áp delta ⇒ phát delta kèm ĐÚNG những dòng đã áp, previous và next", async () => {
    const { events, seen } = listen();
    const after = [flag("a", true)];
    const h = harness({
      deltaMode: true,
      cached: { version: 7, flags: [flag("a", false)] },
      target: { configVersion: 8, configHash: configHashOf(snap(after)) },
      records: [deltaRow(8, "flag.updated", flag("a", true))],
      events,
    });

    await h.cache.get(ENV, "SERVER");
    await h.watcher.tick();

    expect(seen).toMatchObject([
      {
        kind: "delta",
        previous: { configVersion: 7 },
        next: { configVersion: 8 },
        records: [{ configVersion: 8, changeType: "flag.updated" }],
      },
    ]);
  });

  it("rơi về snapshot ⇒ phát snapshot mang bộ ba mới", async () => {
    const { events, seen } = listen();
    const after = [flag("a", true)];
    const h = harness({
      deltaMode: true,
      cached: { version: 7, flags: [flag("a", false)] },
      target: { configVersion: 9, configHash: configHashOf(snap(after)) },
      // hổng: thiếu version 8
      records: [deltaRow(9, "flag.updated", flag("a", true))],
      events,
    });

    await h.cache.get(ENV, "SERVER");
    h.state.setStored(9, after);
    await h.watcher.tick();

    expect(seen.map((c) => [c.kind, c.next.configVersion])).toEqual([
      ["snapshot", 9],
    ]);
  });

  it("nạp lại CÙNG version vì lệch hash VẪN phát snapshot — ca tự sửa của I15a", async () => {
    /**
     * Số đúng, nội dung sai: cache giữ `a=false` ở version 7 trong khi database
     * nói hash của `a=true`. Bỏ qua sự kiện "vì version không đổi" là giữ mọi SDK
     * ở lại đúng cái nội dung sai đó.
     */
    const { events, seen } = listen();
    const truth = [flag("a", true)];
    const h = harness({
      deltaMode: true,
      cached: { version: 7, flags: [flag("a", false)] },
      target: { configVersion: 7, configHash: configHashOf(snap(truth)) },
      events,
    });

    await h.cache.get(ENV, "SERVER");
    h.state.setStored(7, truth);
    await h.watcher.tick();

    expect(seen).toHaveLength(1);
    expect(seen[0]?.kind).toBe("snapshot");
    expect(seen[0]?.next.configVersion).toBe(7);
    expect(seen[0]?.next.snapshot.flags).toEqual(truth);
  });

  it("listener ném — đồng bộ hay bất đồng bộ — không chặn listener khác và không làm hỏng vòng", async () => {
    const events = createConfigChangeEvents();
    const seen: string[] = [];
    events.subscribe(() => {
      throw new Error("listener hỏng");
    });
    events.subscribe(() => Promise.reject(new Error("listener async hỏng")));
    events.subscribe((change) => {
      seen.push(change.kind);
    });

    const after = [flag("a", true)];
    const h = harness({
      deltaMode: true,
      cached: { version: 7, flags: [flag("a", false)] },
      target: { configVersion: 8, configHash: configHashOf(snap(after)) },
      records: [deltaRow(8, "flag.updated", flag("a", true))],
      events,
    });

    await h.cache.get(ENV, "SERVER");
    await expect(h.watcher.tick()).resolves.toBeUndefined();
    expect(seen).toEqual(["delta"]);
    expect(h.cache.peek(ENV, "SERVER")?.configVersion).toBe(8);
  });
});

describe("wake() — một cổng vào cho vòng poll (Plan #13, Mục 4)", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  const STATE = { configVersion: 1, configHash: configHashOf(snap([])) };

  /** Watcher trên feed đếm số vòng; `hang` giữ `statesOf` treo tới khi `release()` */
  const counting = (hang = false) => {
    let calls = 0;
    const pending: (() => void)[] = [];
    const feed: ChangeFeed = {
      statesOf: (ids) => {
        calls += 1;
        const result = new Map(ids.map((id) => [id, STATE]));
        if (!hang) return Promise.resolve(result);
        return new Promise((resolve) => {
          pending.push(() => {
            resolve(result);
          });
        });
      },
      deltasSince: () => Promise.resolve([]),
    };
    const cache = createSnapshotCache((environmentId) =>
      Promise.resolve({
        environmentId,
        environmentName: "dev",
        configVersion: 1,
        configHash: STATE.configHash,
        snapshot: snap([]),
      }),
    );
    const watcher = createVersionWatcher({
      feed,
      cache,
      breaker: createCircuitBreaker(),
      deltaMode: false,
    });
    return {
      watcher,
      cache,
      calls: () => calls,
      release: () => {
        pending.shift()?.();
      },
    };
  };

  it("chưa start: wake chạy ĐÚNG một vòng và không tự bật polling", async () => {
    vi.useFakeTimers();
    const w = counting();
    await w.cache.get(ENV, "SERVER");

    w.watcher.wake();
    await vi.advanceTimersByTimeAsync(10_000);

    expect(w.calls()).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("20 lần wake liên tiếp không nhân chuỗi timer — chỉ còn MỘT timer chờ", async () => {
    vi.useFakeTimers();
    const w = counting();
    await w.cache.get(ENV, "SERVER");

    w.watcher.start();
    for (let i = 0; i < 20; i += 1) {
      w.watcher.wake();
      await vi.advanceTimersByTimeAsync(0);
    }

    expect(vi.getTimerCount()).toBe(1);
    const before = w.calls();
    // Một chu kỳ poll tối đa (500ms + jitter 200ms) chỉ được thêm ĐÚNG một vòng
    await vi.advanceTimersByTimeAsync(700);
    expect(w.calls()).toBe(before + 1);
    w.watcher.stop();
  });

  it("wake trong lúc vòng đang bay: không chồng vòng, chạy lại đúng MỘT lần sau đó", async () => {
    vi.useFakeTimers();
    const w = counting(true);
    await w.cache.get(ENV, "SERVER");

    w.watcher.wake();
    await vi.advanceTimersByTimeAsync(0);
    w.watcher.wake();
    w.watcher.wake();
    await vi.advanceTimersByTimeAsync(0);
    expect(w.calls()).toBe(1);

    w.release();
    await vi.advanceTimersByTimeAsync(0);
    expect(w.calls()).toBe(2);

    w.release();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(w.calls()).toBe(2);
  });

  it("sau stop: wake là no-op, và vòng đang bay xong cũng không lập lịch lại", async () => {
    vi.useFakeTimers();
    const w = counting(true);
    await w.cache.get(ENV, "SERVER");

    w.watcher.start();
    await vi.advanceTimersByTimeAsync(700);
    expect(w.calls()).toBe(1);

    w.watcher.stop();
    w.watcher.wake();
    w.release();
    await vi.advanceTimersByTimeAsync(10_000);

    expect(w.calls()).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("cache.holds — lọc notice của tầng 3", () => {
  it("true khi đang giữ HOẶC đang nạp; false với environment lạ", async () => {
    const OTHER = "44444444-4444-4444-8444-444444444444";
    let finish: () => void = () => undefined;
    const cache = createSnapshotCache(
      (environmentId) =>
        new Promise((resolve) => {
          finish = () => {
            resolve({
              environmentId,
              environmentName: "dev",
              configVersion: 1,
              configHash: "",
              snapshot: snap([]),
            });
          };
        }),
    );

    const loading = cache.get(ENV, "SERVER");
    expect(cache.holds(ENV)).toBe(true);
    expect(cache.holds(OTHER)).toBe(false);

    finish();
    await loading;
    expect(cache.holds(ENV)).toBe(true);
    expect(cache.holds(OTHER)).toBe(false);
  });
});
