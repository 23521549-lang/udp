import { ValidationError } from "@udp/http";

/**
 * Fencing token của I23 — `If-Match: "<sessionId>:<version>"` (§7.3, §9).
 *
 * `version` là `RolloutSession.version`, tăng mỗi lần một worker giành lease.
 * Worker tỉnh dậy sau khi đã mất lease vẫn cầm version cũ, và Service 2 từ chối
 * nó bằng 412 — chốt chặn ở PHÍA BÊN KIA lời gọi mạng, chỗ mà optimistic lock
 * của database không với tới (I23).
 */
export interface FencingToken {
  sessionId: string;
  version: number;
}

/**
 * Bóc CHẶT: đúng một hình dạng đi qua, mọi thứ khác là 400.
 *
 * Mỗi dạng dưới đây là thứ một cách bóc dễ dãi sẽ cho qua:
 *
 *   - `split(":")` để lại dấu ngoặc kép ở cuối version: `Number('5"')` ra `NaN`,
 *     còn `parseInt('5"')` ra `5` — chọn hàm nào là chọn "chặn hết" hay "cho
 *     qua", mà không cái nào là bóc.
 *   - Hai header `If-Match` tới tay Express thành MỘT chuỗi `"a:1", "b:2"` — Node
 *     nối header trùng tên bằng dấu phẩy, đúng như RFC 9110 coi hai cách gửi là
 *     một danh sách.
 *   - `W/"…"` là entity tag yếu, còn `*` nghĩa là "khớp bất kỳ" — ngữ nghĩa chuẩn
 *     của HTTP, và cả hai đều không phải token.
 *   - `05`: Service 3 sinh version bằng `${session.version}` (§7.3), nên số 0 đứng
 *     đầu chỉ có thể là tay người hoặc bug.
 *
 * Regex neo hai đầu nên cả bốn dạng đều trượt.
 */
const TOKEN =
  /^"([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}):(0|[1-9][0-9]{0,9})"$/i;

/** `RolloutSession.version` là INTEGER */
const INT4_MAX = 2_147_483_647;

/**
 * THIẾU header là 400, không phải "ghi không điều kiện".
 *
 * Theo HTTP, request không có `If-Match` là ghi vô điều kiện — đúng thứ fencing
 * sinh ra để cấm. 428 (Precondition Required) nói điều đó chính xác hơn nhưng
 * không có trong catalog 21 mã của §9; một request thiếu header bắt buộc là
 * request sai hình dạng, và 400 nói đúng điều đó.
 */
export function parseFencingToken(header: string | undefined): FencingToken {
  if (header === undefined || header.length === 0) {
    throw new ValidationError(
      'Thiếu header If-Match — PATCH rule bắt buộc mang fencing token "<sessionId>:<version>"',
    );
  }

  const [, sessionId, raw] = TOKEN.exec(header) ?? [];
  if (sessionId === undefined || raw === undefined) {
    throw new ValidationError(
      'If-Match phải đúng dạng "<sessionId>:<version>" — có ngoặc kép, đúng một giá trị',
    );
  }

  const version = Number(raw);
  if (version > INT4_MAX) {
    throw new ValidationError("version trong If-Match vượt khoảng INTEGER");
  }

  return { sessionId: sessionId.toLowerCase(), version };
}
