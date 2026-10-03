import { describe, expect, it } from "vitest";
import { createResultCache } from "../src/ofrep/result-cache.js";

/** LRU của OFREP có HAI trần — số mục và tổng byte (QA code Plan #20) */
describe("createResultCache", () => {
  it("vượt trần mục ⇒ bỏ mục cũ nhất; lấy ra là 'vừa dùng'", () => {
    const c = createResultCache({ maxEntries: 2, maxBytes: 1_000 });
    c.set("a", "1");
    c.set("b", "2");
    c.get("a");
    c.set("c", "3");
    expect(c.get("b")).toBeUndefined();
    expect(c.get("a")).toBe("1");
    expect(c.size).toBe(2);
  });

  it("vượt trần byte ⇒ bỏ mục cũ tới khi vừa; mục lớn hơn cả trần thì không giữ", () => {
    const c = createResultCache({ maxEntries: 100, maxBytes: 10 });
    c.set("a", "xxxx");
    c.set("b", "yyyy");
    c.set("c", "zzzz");
    expect(c.get("a")).toBeUndefined();
    expect(c.bytes).toBeLessThanOrEqual(10);
    c.set("huge", "x".repeat(11));
    expect(c.get("huge")).toBeUndefined();
    expect(c.bytes).toBeLessThanOrEqual(10);
  });

  it("ghi đè cùng khoá không đếm byte hai lần", () => {
    const c = createResultCache({ maxEntries: 10, maxBytes: 100 });
    c.set("a", "xxxx");
    c.set("a", "yy");
    expect(c.bytes).toBe(2);
  });
});
