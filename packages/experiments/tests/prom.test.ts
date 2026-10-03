import { describe, expect, it } from "vitest";
import { counterValue } from "../src/prom.js";

const text = [
  "# HELP udp_flag_db_queries_total x",
  "udp_flag_db_queries_total 42",
  'udp_flag_sse_bytes_total{event="snapshot"} 1234',
].join("\n");

describe("counterValue", () => {
  it("đọc bộ đếm có và không có nhãn", () => {
    expect(counterValue(text, "udp_flag_db_queries_total")).toBe(42);
    expect(
      counterValue(text, "udp_flag_sse_bytes_total", '{event="snapshot"}'),
    ).toBe(1234);
  });

  it("vắng là LỖI, không phải 0", () => {
    expect(() =>
      counterValue(text, "udp_flag_sse_bytes_total", '{event="retry"}'),
    ).toThrow(/thiếu/);
  });
});
