import { z } from "zod";

/**
 * Kênh `NOTIFY rollout_intent` (§7.6 [v4.3]) — Service 1 phát TRONG transaction
 * ghi intent, Service 3 nghe để xử lý ngay thay vì chờ vòng quét 5 giây.
 *
 * Cùng hợp đồng với kênh tầng 3 của ADR-05: notice chỉ ĐÁNH THỨC, không mang
 * dữ liệu. Service 3 vẫn đọc intent từ `rollout_events` qua lease, nên notice
 * mất, trùng hay giả chỉ làm việc chậm hơn hoặc thừa một lượt — không sai hơn.
 * Một cặp hàm cho cả hai đầu: lệch tên trường là lỗi biên dịch, không phải kênh
 * im lặng.
 */
export const ROLLOUT_INTENT_CHANNEL = "rollout_intent";

export interface RolloutIntentNotice {
  sessionId: string;
}

const noticeSchema = z.object({ sessionId: z.string().uuid() });

export function formatRolloutIntentNotice(notice: RolloutIntentNotice): string {
  return JSON.stringify({ sessionId: notice.sessionId });
}

/**
 * Sai hình dạng thì `null`, KHÔNG ném. PostgreSQL không có quyền trên `NOTIFY`:
 * mọi role nối được database đều phát được lên kênh này.
 */
export function parseRolloutIntentNotice(
  payload: string,
): RolloutIntentNotice | null {
  let value: unknown;
  try {
    value = JSON.parse(payload);
  } catch {
    return null;
  }
  const parsed = noticeSchema.safeParse(value);
  return parsed.success ? { sessionId: parsed.data.sessionId } : null;
}
