import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import { toast } from "../../components/Toast";
import { messagesOf } from "../../i18n";
import { qk } from "../../lib/query-keys";
import { rolloutApi } from "./rollout-api";
import { rolloutMessages } from "./rollout.messages";

/**
 * Báo khi một rollout ĐANG CHẠY biến khỏi danh sách đang chạy (§10.9
 * useGlobalRolloutWatcher): nó vừa kết thúc — hoàn tất, hoặc tự rollback trong lúc người
 * dùng đang ở màn hình khác. Hỏi mỗi 15s; không có gì chạy thì vẫn hỏi, vì rollout mới có
 * thể do người khác tạo.
 *
 * Hàm so sánh tách riêng để test được không cần hẹn giờ.
 */
export function finishedSince(
  previous: readonly { id: string; flagKey: string | null }[],
  current: readonly { id: string }[],
): { id: string; flagKey: string | null }[] {
  const still = new Set(current.map((r) => r.id));
  return previous.filter((r) => !still.has(r.id));
}

export function useRolloutWatcher(projectId: string): void {
  const prev = useRef<{ id: string; flagKey: string | null }[] | null>(null);
  const active = useQuery({
    queryKey: qk.activeRollouts(projectId),
    queryFn: () => rolloutApi.active(projectId),
    refetchInterval: 15_000,
  });

  useEffect(() => {
    const now = active.data?.rollouts;
    if (now === undefined) return;
    if (prev.current !== null) {
      // Chữ đọc lúc sự kiện xảy ra: hook này không vẽ gì nên không theo dõi ngôn ngữ
      const m = messagesOf(rolloutMessages).watcher;
      for (const r of finishedSince(prev.current, now)) {
        toast.info(m.finished(r.flagKey ?? r.id.slice(0, 8)));
      }
    }
    prev.current = now.map((r) => ({ id: r.id, flagKey: r.flagKey }));
  }, [active.data]);
}
