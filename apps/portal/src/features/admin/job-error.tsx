import type { Tone } from "../../components/StatusLabel";
import { useMessages } from "../../i18n";
import { adminMessages } from "./admin.messages";

/**
 * Lỗi của job đọc được: `lastError` của worker là `{step, message, orphans}` (§8.1). Dạng khác — job
 * cũ hơn khuôn đó — rơi về JSON trong khối "Chi tiết kỹ thuật", không bao giờ mất.
 */
export function readableJobError(
  lastError: unknown,
): { step: string; message: string; orphans: number } | null {
  if (typeof lastError !== "object" || lastError === null) return null;
  const e = lastError as Record<string, unknown>;
  if (typeof e.message !== "string") return null;
  return {
    step: typeof e.step === "string" ? e.step : "",
    message: e.message,
    orphans: Array.isArray(e.orphans) ? e.orphans.length : 0,
  };
}

/** Job đang huỷ còn chạy; mọi trạng thái khác của danh sách quản trị là lỗi */
export const jobStateTone = (state: string): Tone =>
  state === "CANCEL_REQUESTED" ? "running" : "error";

/** [Plan #58 UX-32] Một câu lỗi của job — trang Job lỗi và panel project dùng chung */
export function JobErrorText({ lastError }: { lastError: unknown }) {
  const m = useMessages(adminMessages).jobs;
  const err = readableJobError(lastError);
  if (err === null) return null;
  return (
    <p className="job-err">
      {err.step !== "" &&
        m.step(
          <span className="mono" translate="no">
            {err.step}
          </span>,
        )}
      {err.message}
      {err.orphans > 0 && ` ${m.leftover(err.orphans)}`}
    </p>
  );
}
