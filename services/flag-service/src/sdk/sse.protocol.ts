import { ValidationError } from "@udp/http";
import { INT4_MAX } from "../core/int4.js";

/**
 * Chữ trên dây của `GET /sdk/stream` (§6.3) — không trạng thái, không I/O.
 *
 * Hub (`sse.manager.ts`) quyết định gửi GÌ và cho AI; file này chỉ quyết định nó
 * trông thế nào trên dây. Tách ra để hai câu hỏi đó kiểm được riêng.
 */

/**
 * Header chống proxy đệm (§6.3, "Năm cơ chế tin cậy").
 *
 * Thiếu `X-Accel-Buffering: no` thì nginx gom event tới khi đầy buffer — SDK nhận
 * muộn hàng chục giây mà không có lỗi nào. `no-transform` cấm proxy nén hay biến
 * đổi luồng, vì nén cũng là đệm.
 */
export const STREAM_HEADERS: Readonly<Record<string, string>> = {
  "Content-Type": "text/event-stream",
  "Cache-Control": "no-cache, no-transform",
  "X-Accel-Buffering": "no",
};

/** Nhịp tim — một dòng chú thích của SSE: SDK bỏ qua, proxy thấy byte chạy */
export const HEARTBEAT = ":\n\n";

/**
 * Một event SSE.
 *
 * `data` là JSON MỘT dòng: `JSON.stringify` thoát mọi xuống dòng nằm trong chuỗi,
 * nên không bao giờ sinh ra dòng trống giữa chừng — mà dòng trống là dấu kết thúc
 * event của SSE. `id` là `configVersion` sau event, nên `Last-Event-ID` mà SDK tự
 * gửi khi nối lại chính là con trỏ của nó.
 */
export function formatEvent(event: {
  id: number;
  name: string;
  data: unknown;
}): string {
  return `id: ${String(event.id)}\nevent: ${event.name}\ndata: ${JSON.stringify(event.data)}\n\n`;
}

/** Trường `retry:` — SDK chờ bấy nhiêu mili-giây trước khi nối lại */
export const retryField = (ms: number): string =>
  `retry: ${String(Math.round(ms))}\n\n`;

/**
 * Ba dạng con trỏ: `41`, `"41"`, `W/"41"` — `since` chép nguyên từ ETag của
 * `/sdk/config` vẫn dùng được (§6.3). Không số 0 đứng đầu, tối đa 10 chữ số: đúng
 * luật mà fencing token của Plan #12 đã chốt cho version.
 */
const CURSOR =
  /^(?:(0|[1-9][0-9]{0,9})|"(0|[1-9][0-9]{0,9})"|W\/"(0|[1-9][0-9]{0,9})")$/;

/**
 * Con trỏ của stream, hoặc `undefined` nếu không có.
 *
 * `Last-Event-ID` THẮNG `?since=`: `EventSource` tự gửi `Last-Event-ID` khi nối
 * lại, còn URL vẫn giữ `since` của lần nối đầu — ưu tiên ngược lại là mỗi lần nối
 * lại đều bị kéo về con trỏ cũ và nhận snapshot thừa.
 *
 * Có mặt mà sai dạng — kể cả chuỗi rỗng, kể cả `since` lặp hai lần — là 400,
 * không phải "coi như không có": đoán hộ một con trỏ hỏng là che bug của SDK.
 */
export function parseCursor(
  lastEventId: string | undefined,
  since: unknown,
): number | undefined {
  const raw = lastEventId ?? since;
  if (raw === undefined) return undefined;

  if (typeof raw !== "string") {
    throw new ValidationError("Con trỏ `since` phải xuất hiện đúng một lần");
  }

  const match = CURSOR.exec(raw);
  const digits = match?.[1] ?? match?.[2] ?? match?.[3];
  const cursor = digits === undefined ? undefined : Number(digits);

  if (cursor === undefined || cursor > INT4_MAX) {
    throw new ValidationError(
      'Con trỏ không hợp lệ — nhận `41`, `"41"` hoặc `W/"41"`, trong khoảng INTEGER',
    );
  }
  return cursor;
}
