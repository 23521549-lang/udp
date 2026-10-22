/**
 * Ước lượng dung lượng segment ở trình duyệt (sổ nợ `portal-segment-quota`).
 *
 * Trần 4 MiB là của CẢ project, đo bằng `octet_length(conditions::text)` của jsonb dưới
 * khoá ở Service 2. Portal không đo được đúng thước đó, nên nói hai con số:
 *
 * - **Chặn dưới**: JSON gọn (không khoảng trắng) — cùng tính chất với
 *   `segmentPayloadBytesOf` của `flag-snapshot`: jsonb::text chỉ có thể DÀI HƠN (Postgres
 *   in thêm một khoảng trắng sau mỗi `,` và `:`, và in số ở dạng `numeric`). Vượt trần theo
 *   con số này là CHẮC CHẮN bị từ chối.
 * - **Ước lượng trên**: chặn dưới cộng số dấu `,` và `:` — đúng khoảng trắng Postgres thêm,
 *   cộng thừa những dấu nằm trong chuỗi. Vượt theo con số này là CÓ THỂ bị từ chối.
 *
 * `userIds` được khử trùng trước khi đo: server khử trùng trước khi lưu (V13).
 */
export interface SegmentSize {
  lower: number;
  upper: number;
}

export function segmentSizeOf(conditions: {
  all: readonly unknown[];
  userIds: readonly string[];
}): SegmentSize {
  const text = JSON.stringify({
    all: conditions.all,
    userIds: [...new Set(conditions.userIds)],
  });
  const lower = new TextEncoder().encode(text).length;
  const separators = (text.match(/[,:]/g) ?? []).length;
  return { lower, upper: lower + separators };
}

export type QuotaVerdict = "ok" | "maybe" | "over";

/**
 * Dự báo sau khi lưu: tổng hiện tại của project, trừ bản cũ của segment đang sửa (nếu
 * có), cộng bản mới. Chỉ là cảnh báo — không chặn nút Lưu, vì `quota` có thể đã cũ (người
 * khác vừa xoá segment) và chặn oan tệ hơn để server quyết.
 */
export function quotaVerdict(input: {
  projectBytes: number;
  maxBytes: number;
  editingBytes: number;
  next: SegmentSize;
}): { verdict: QuotaVerdict; projectedLower: number } {
  const base = Math.max(0, input.projectBytes - input.editingBytes);
  const projectedLower = base + input.next.lower;
  if (projectedLower > input.maxBytes)
    return { verdict: "over", projectedLower };
  if (base + input.next.upper > input.maxBytes) {
    return { verdict: "maybe", projectedLower };
  }
  return { verdict: "ok", projectedLower };
}
