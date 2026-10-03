/**
 * Parser Server-Sent Events theo đặc tả WHATWG (HTML §9.2) [v4.7] — tự viết, 0 phụ
 * thuộc: `eventsource`/`eventsource-parser` bản hiện hành đòi Node ≥ 22.12 (repo
 * khai ≥ 20.11), và provider phải tự quản việc nối lại (đếm lỗi, `Retry-After`,
 * 401, RESYNC không con trỏ) — thứ một client EventSource che mất.
 *
 * Đẩy từng mảnh chữ vào (`feed`), nhận lại từng sự kiện đã hoàn chỉnh. Dòng kết
 * thúc bằng CRLF, CR hoặc LF; BOM đầu stream bị bỏ; dòng bắt đầu bằng `:` là chú
 * thích (nhịp tim của Service 2) — không thành sự kiện nhưng vẫn là dấu hiệu SỐNG.
 */

import { PROVIDER } from "@udp/config/constants";

export type SseItem =
  | { kind: "event"; event: string; data: string; id: string | undefined }
  | { kind: "retry"; ms: number }
  /** Có byte tới nhưng không thành sự kiện (nhịp tim, dòng trống lẻ) */
  | { kind: "activity" };

export interface SseParser {
  feed(chunk: string): SseItem[];
}

/**
 * `maxLineChars`: một dòng dài hơn ⇒ `feed` NÉM `RangeError` (stream hỏng — nơi gọi
 * huỷ kết nối và đếm một lần hỏng), thay vì giữ bộ nhớ của ứng dụng khách vô hạn.
 */
export function createSseParser(
  maxLineChars: number = PROVIDER.maxSseLineChars,
): SseParser {
  let buffer = "";
  let first = true;
  let pendingCr = false;
  let event = "";
  let data: string[] = [];
  let id: string | undefined;

  const dispatch = (out: SseItem[]): void => {
    if (data.length === 0) {
      event = "";
      return;
    }
    out.push({
      kind: "event",
      event: event === "" ? "message" : event,
      data: data.join("\n"),
      id,
    });
    event = "";
    data = [];
  };

  const line = (text: string, out: SseItem[]): void => {
    if (text === "") {
      dispatch(out);
      return;
    }
    if (text.startsWith(":")) return;
    const colon = text.indexOf(":");
    const field = colon === -1 ? text : text.slice(0, colon);
    let value = colon === -1 ? "" : text.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    switch (field) {
      case "event":
        event = value;
        break;
      case "data":
        data.push(value);
        break;
      case "id":
        if (!value.includes("\u0000")) id = value;
        break;
      case "retry":
        if (/^\d+$/.test(value)) out.push({ kind: "retry", ms: Number(value) });
        break;
      default:
        break;
    }
  };

  return {
    feed(chunk) {
      // Mảnh rỗng không mang byte nào: không được tiêu CR đang chờ hay chỗ của BOM
      if (chunk === "") return [];
      const out: SseItem[] = [];
      let text = chunk;
      if (first) {
        first = false;
        if (text.startsWith("\uFEFF")) text = text.slice(1);
      }
      // CR ở cuối mảnh trước + LF đầu mảnh này là MỘT xuống dòng (CRLF bị cắt đôi)
      if (pendingCr && text.startsWith("\n")) text = text.slice(1);
      pendingCr = false;
      // `buffer` chỉ còn phần dòng dở — không chứa ký tự xuống dòng nào — nên chỉ quét
      // phần MỚI: quét lại từ đầu là O(n²) theo độ dài dòng, mà snapshot là MỘT dòng
      // (đo: 8 MiB theo mảnh 64 KiB tốn 8,2 giây CPU của ứng dụng khách)
      const scanFrom = buffer.length;
      buffer += text;
      let start = 0;
      for (let i = scanFrom; i < buffer.length; i += 1) {
        const ch = buffer[i];
        if (ch !== "\n" && ch !== "\r") continue;
        line(buffer.slice(start, i), out);
        if (ch === "\r") {
          if (i + 1 < buffer.length) {
            if (buffer[i + 1] === "\n") i += 1;
          } else {
            pendingCr = true;
          }
        }
        start = i + 1;
      }
      buffer = buffer.slice(start);
      if (buffer.length > maxLineChars) {
        throw new RangeError(
          `dòng SSE dài hơn ${String(maxLineChars)} ký tự — stream hỏng`,
        );
      }
      if (out.length === 0 && chunk.length > 0) out.push({ kind: "activity" });
      return out;
    },
  };
}
