import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TimezoneSource } from "../src/timezones.js";

/**
 * `loadTimezoneNames` nhớ MỘT promise cho cả tiến trình. Thứ cần chốt là hai mặt
 * của việc nhớ đó: không hỏi lại khi đã có, và KHÔNG nhớ một lần hỏi hỏng. Nạp lại
 * module ở mỗi test để trạng thái nhớ không rò giữa các ca.
 */

const fakeSource = (
  query: () => Promise<{ name: string }[]>,
): TimezoneSource & { calls: () => number } => {
  let calls = 0;
  return {
    $queryRaw: <T>() => {
      calls += 1;
      return query() as unknown as Promise<T>;
    },
    calls: () => calls,
  };
};

const load = async () =>
  (await import("../src/timezones.js")).loadTimezoneNames;

beforeEach(() => {
  vi.resetModules();
});

describe("loadTimezoneNames", () => {
  it("hỏi database đúng một lần cho mọi lời gọi", async () => {
    const loadTimezoneNames = await load();
    const source = fakeSource(() =>
      Promise.resolve([{ name: "UTC" }, { name: "Asia/Ho_Chi_Minh" }]),
    );

    const [a, b] = await Promise.all([
      loadTimezoneNames(source),
      loadTimezoneNames(source),
    ]);
    const c = await loadTimezoneNames(source);

    expect([...a]).toEqual(["UTC", "Asia/Ho_Chi_Minh"]);
    expect(b).toBe(a);
    expect(c).toBe(a);
    expect(source.calls()).toBe(1);
  });

  it("lần hỏi lỗi không bị nhớ — lời gọi kế thử lại", async () => {
    const loadTimezoneNames = await load();
    const failing = fakeSource(() => Promise.reject(new Error("mất kết nối")));
    const healthy = fakeSource(() => Promise.resolve([{ name: "UTC" }]));

    await expect(loadTimezoneNames(failing)).rejects.toThrow("mất kết nối");
    expect((await loadTimezoneNames(healthy)).has("UTC")).toBe(true);
    expect(healthy.calls()).toBe(1);
  });
});
