import { describe, expect, it } from "vitest";
import { createSseParser, type SseItem } from "../src/sse.js";

/** Parser SSE theo WHATWG — cắt dòng ở CRLF/CR/LF, kể cả khi bị chia đôi giữa hai mảnh */

const events = (items: SseItem[]) => items.filter((i) => i.kind === "event");

describe("createSseParser", () => {
  it("id/event/data nhiều dòng; dòng trống kết thúc sự kiện", () => {
    const p = createSseParser();
    const out = p.feed('id: 7\nevent: snapshot\ndata: {"a":1}\ndata: x\n\n');
    expect(events(out)).toEqual([
      { kind: "event", event: "snapshot", data: '{"a":1}\nx', id: "7" },
    ]);
  });

  it("CRLF và CR đều là xuống dòng — kể cả CRLF bị cắt đôi giữa hai mảnh", () => {
    const p = createSseParser();
    expect(events(p.feed("data: a\r"))).toEqual([]);
    const out = p.feed("\n\r\ndata: b\r\r");
    expect(events(out).map((e) => e.data)).toEqual(["a", "b"]);
  });

  it("chú thích (nhịp tim) không thành sự kiện nhưng là dấu hiệu sống; retry được đọc", () => {
    const p = createSseParser();
    expect(p.feed(":\n\n")).toEqual([{ kind: "activity" }]);
    expect(p.feed("retry: 3000\n\n")).toEqual([{ kind: "retry", ms: 3000 }]);
  });

  it("BOM đầu stream bị bỏ; sự kiện không có data không được phát", () => {
    const p = createSseParser();
    const out = p.feed("\uFEFFevent: x\n\ndata: y\n\n");
    expect(events(out)).toEqual([
      { kind: "event", event: "message", data: "y", id: undefined },
    ]);
  });

  it("dữ liệu tới từng byte vẫn ra đúng một sự kiện", () => {
    const p = createSseParser();
    const text = "event: flag_changed\ndata: 1\n\n";
    const all: SseItem[] = [];
    for (const ch of text) all.push(...p.feed(ch));
    expect(events(all)).toHaveLength(1);
  });
});

describe("createSseParser — hồi quy QA code Plan #21", () => {
  it("mảnh rỗng giữa CR và LF không tách một sự kiện làm hai", () => {
    const p = createSseParser();
    const all = [
      ...p.feed("data: a\r"),
      ...p.feed(""),
      ...p.feed("\ndata: b\r\n\r\n"),
    ];
    expect(events(all).map((e) => e.data)).toEqual(["a\nb"]);
  });

  it("mảnh rỗng đầu stream không tiêu mất chỗ của BOM", () => {
    const p = createSseParser();
    p.feed("");
    const out = p.feed("\uFEFFevent: snapshot\ndata: x\n\n");
    expect(events(out)).toEqual([
      { kind: "event", event: "snapshot", data: "x", id: undefined },
    ]);
  });

  it("một dòng rất dài theo nhiều mảnh là TUYẾN TÍNH (snapshot là một dòng)", () => {
    const p = createSseParser();
    const piece = "x".repeat(64 * 1024);
    const started = Date.now();
    p.feed("data: ");
    for (let i = 0; i < 128; i += 1) p.feed(piece); // 8 MiB
    const out = p.feed("\n\n");
    expect(Date.now() - started).toBeLessThan(2_000); // O(n²) cũ: 8,2 giây
    expect(events(out)[0]?.data.length).toBe(8 * 1024 * 1024);
  });

  it("dòng vượt trần ⇒ NÉM (stream hỏng), không giữ bộ nhớ vô hạn", () => {
    const p = createSseParser(16);
    p.feed("data: 0123456789");
    expect(() => p.feed("abcdef")).toThrow(RangeError);
  });
});
