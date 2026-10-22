import { describe, expect, it } from "vitest";
import { parseSseBlock } from "../e2e/support.js";

/** Bộ tách SSE của E2E (Plan #50) — E2E chỉ chạy trên cụm, nên phần thuần của nó kiểm ở đây */

describe("parseSseBlock", () => {
  it("đọc id, tên và data của một event đúng dạng `formatEvent` của Service 2", () => {
    expect(
      parseSseBlock('id: 42\nevent: snapshot\ndata: {"a":"b: c"}'),
    ).toEqual({ id: 42, event: "snapshot", data: '{"a":"b: c"}' });
  });

  it("khối nhịp tim (chú thích) và khối `retry:` không phải event", () => {
    expect(parseSseBlock(":")).toBeNull();
    expect(parseSseBlock("retry: 3000")).toBeNull();
  });
});
