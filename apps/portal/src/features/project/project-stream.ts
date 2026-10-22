import { useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { qkPrefix } from "../../lib/query-keys";
import { projectApi } from "./project-api";

/**
 * [Plan #41 QĐ-3] Luồng `GET /projects/:id/stream` — người thứ hai thấy thay đổi cấu hình của
 * người thứ nhất trong khoảng một giây, không phải sau `staleTime`.
 *
 * - `flag_changed` ⇒ `invalidateQueries` MỌI key cấu hình của project (`qkPrefix.configOf`) —
 *   KHÔNG BAO GIỜ ghi thẳng vào cache: hai nguồn sự thật ở phía client là đúng thứ ADR-05 tránh
 *   ở phía server (§10.14).
 * - `ready` sau một lần nối lại ⇒ cũng invalidate: sự kiện trong lúc đứt không được phát lại.
 * - Luồng ĐÓNG hẳn (phiên hết hạn, máy chủ từ chối) ⇒ mở lại sau backoff tăng dần; phiên được
 *   làm mới bởi các lời gọi thường của trang. Đang nối lại thì để trình duyệt tự làm.
 */
export const STREAM_RETRY_MS = { first: 2_000, max: 30_000 };

export function useProjectStream(projectId: string): void {
  const queryClient = useQueryClient();
  useEffect(() => {
    if (typeof EventSource === "undefined") return;
    let source: EventSource | null = null;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let delay = STREAM_RETRY_MS.first;
    let connectedBefore = false;
    let stopped = false;

    const refresh = () => {
      for (const queryKey of qkPrefix.configOf(projectId)) {
        void queryClient.invalidateQueries({ queryKey });
      }
    };
    const open = () => {
      const current = new EventSource(projectApi.streamUrl(projectId));
      source = current;
      current.addEventListener("ready", () => {
        delay = STREAM_RETRY_MS.first;
        if (connectedBefore) refresh();
        connectedBefore = true;
      });
      current.addEventListener("flag_changed", refresh);
      current.onerror = () => {
        if (stopped || current.readyState !== EventSource.CLOSED) return;
        retry = setTimeout(open, delay);
        delay = Math.min(delay * 2, STREAM_RETRY_MS.max);
      };
    };
    open();
    return () => {
      stopped = true;
      clearTimeout(retry);
      source?.close();
    };
  }, [projectId, queryClient]);
}
