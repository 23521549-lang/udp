import {
  configHashOf,
  type Snapshot,
  type SnapshotFlag,
} from "@udp/flag-evaluator";
import { beforeEach, describe, expect, it } from "vitest";
import type {
  ChangeFeed,
  ChangeRecord,
  EnvironmentState,
} from "../src/changefeed/change-feed.interface.js";
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

  it("change_type lạ (kill_switch của S3) thì rơi tầng, TUYỆT ĐỐI không ném", async () => {
    /**
     * `i30-killswitch.test.ts` ghi ra `change_type = 'kill_switch'`, một giá trị
     * không có trong `ConfigChangeType`, vì Service 3 ghi thẳng database ở nhánh
     * `DEPENDENCY_DOWN` (§7.6). Một `switch` vét cạn có `default: throw` sẽ ném
     * đúng lúc kill-switch vừa được bật vì Service 2 đang chết.
     */
    const after = [flag("a", true)];
    const h = harness({
      deltaMode: true,
      cached: { version: 7, flags: [flag("a", false)] },
      target: { configVersion: 8, configHash: configHashOf(snap(after)) },
      records: [deltaRow(8, "kill_switch", flag("a", true))],
    });

    await h.cache.get(ENV, "SERVER");
    h.state.setStored(8, after);

    await expect(h.watcher.tick()).resolves.toBeUndefined();

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
