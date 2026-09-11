import { ValidationError } from "@udp/http";
import { describe, expect, it } from "vitest";
import {
  formatEvent,
  HEARTBEAT,
  parseCursor,
  retryField,
  STREAM_HEADERS,
} from "../src/sdk/sse.protocol.js";

/**
 * Chữ trên dây của `/sdk/stream` (§6.3). Thuần — không server, không database:
 * mọi dạng con trỏ mà SDK có thể gửi đều kiểm được ở đây trong vài mili-giây.
 */

describe("chữ trên dây của /sdk/stream", () => {
  it("event: id, event, data MỘT dòng, kết thúc bằng đúng một dòng trống", () => {
    const text = formatEvent({
      id: 42,
      name: "snapshot",
      data: { note: "hai\ndòng" },
    });
    expect(text).toBe(
      'id: 42\nevent: snapshot\ndata: {"note":"hai\\ndòng"}\n\n',
    );
    // Dòng trống là dấu kết thúc event — xuống dòng trong dữ liệu phải đã được thoát
    expect(text.indexOf("\n\n")).toBe(text.length - 2);
  });

  it("nhịp tim là chú thích SSE; retry là số nguyên mili-giây", () => {
    expect(HEARTBEAT).toBe(":\n\n");
    expect(retryField(1234.6)).toBe("retry: 1235\n\n");
  });

  it("header chống proxy đệm (§6.3)", () => {
    expect(STREAM_HEADERS).toEqual({
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      "X-Accel-Buffering": "no",
    });
  });
});

describe("parseCursor — ba dạng, Last-Event-ID thắng", () => {
  const valid: [string, number][] = [
    ["41", 41],
    ['"41"', 41],
    ['W/"41"', 41],
    ["0", 0],
    ["2147483647", 2_147_483_647],
  ];

  it.each(valid)("%s ⇒ %d, từ header lẫn từ query", (raw, expected) => {
    expect(parseCursor(raw, undefined)).toBe(expected);
    expect(parseCursor(undefined, raw)).toBe(expected);
  });

  it("không có con trỏ nào ⇒ undefined", () => {
    expect(parseCursor(undefined, undefined)).toBeUndefined();
  });

  it("Last-Event-ID THẮNG since — URL giữ since của lần nối ĐẦU", () => {
    expect(parseCursor("7", "3")).toBe(7);
    expect(parseCursor("7", "rác")).toBe(7);
  });

  it.each([
    "",
    "-1",
    "01",
    "4.1",
    "W/41",
    '"41',
    '41"',
    "abc",
    " 41",
    "2147483648",
    "99999999999",
  ])("%j ⇒ 400", (raw) => {
    expect(() => parseCursor(raw, undefined)).toThrow(ValidationError);
    expect(() => parseCursor(undefined, raw)).toThrow(ValidationError);
  });

  it("since lặp hai lần ⇒ 400, không chọn hộ một giá trị", () => {
    expect(() => parseCursor(undefined, ["1", "2"])).toThrow(ValidationError);
  });
});
