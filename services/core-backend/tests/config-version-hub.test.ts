import { describe, expect, it } from "vitest";
import {
  createConfigVersionHub,
  type ConfigChange,
  type EnvironmentVersion,
} from "../src/modules/project/config-version-hub.js";

/**
 * Plan #41 AC-2 — hub `config_version` của luồng Portal: MỘT câu đọc mỗi vòng cho mọi project
 * đang mở; vòng đầu của project chỉ ghi mốc; chỉ environment TIẾN version mới phát; không luồng
 * nào thì không đọc gì.
 */

function world(initial: EnvironmentVersion[]) {
  let rows = initial;
  const reads: string[][] = [];
  let release: (() => void) | null = null;
  let slow = false;
  const hub = createConfigVersionHub({
    pollMs: 3_600_000,
    read: async (projectIds) => {
      reads.push([...projectIds].sort());
      if (slow) await new Promise<void>((r) => (release = r));
      return rows;
    },
  });
  return {
    hub,
    reads,
    set: (next: EnvironmentVersion[]) => {
      rows = next;
    },
    slowRead: () => {
      slow = true;
    },
    finishRead: () => {
      slow = false;
      release?.();
    },
  };
}

const v = (
  projectId: string,
  environmentId: string,
  configVersion: number,
): EnvironmentVersion => ({ projectId, environmentId, configVersion });

describe("createConfigVersionHub", () => {
  it("vòng đầu chỉ ghi mốc; env tiến version ⇒ chỉ luồng của ĐÚNG project nhận, đúng env", async () => {
    const w = world([v("p1", "a", 3), v("p1", "b", 1), v("p2", "c", 7)]);
    const got1: ConfigChange[] = [];
    const got2: ConfigChange[] = [];
    w.hub.subscribe("p1", (c) => got1.push(c));
    w.hub.subscribe("p2", (c) => got2.push(c));

    await w.hub.tick();
    expect(got1).toEqual([]);

    w.set([v("p1", "a", 4), v("p1", "b", 1), v("p2", "c", 7)]);
    await w.hub.tick();
    expect(got1).toEqual([{ environmentId: "a", configVersion: 4 }]);
    expect(got2).toEqual([]);
  });

  it("N luồng của K project ⇒ MỘT câu đọc mỗi vòng, mang đủ K project", async () => {
    const w = world([]);
    w.hub.subscribe("p1", () => undefined);
    w.hub.subscribe("p1", () => undefined);
    w.hub.subscribe("p2", () => undefined);

    await w.hub.tick();
    expect(w.reads).toEqual([["p1", "p2"]]);
  });

  it("luồng cuối đóng ⇒ ngừng đọc; mở lại ⇒ ghi mốc lại từ đầu (không phát thay đổi cũ)", async () => {
    const w = world([v("p1", "a", 1)]);
    const got: ConfigChange[] = [];
    const off = w.hub.subscribe("p1", (c) => got.push(c));
    await w.hub.tick();
    off();
    await w.hub.tick();
    expect(w.reads).toHaveLength(1);

    w.set([v("p1", "a", 9)]);
    w.hub.subscribe("p1", (c) => got.push(c));
    await w.hub.tick();
    expect(got).toEqual([]);
  });

  it("vòng trước chưa xong ⇒ vòng sau bỏ qua, không chồng truy vấn", async () => {
    const w = world([v("p1", "a", 1)]);
    w.hub.subscribe("p1", () => undefined);
    w.slowRead();
    const first = w.hub.tick();
    await w.hub.tick();
    expect(w.reads).toHaveLength(1);
    w.finishRead();
    await first;
  });
});
