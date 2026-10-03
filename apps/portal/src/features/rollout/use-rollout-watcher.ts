import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import type { RolloutSummaryWire } from "@udp/shared-types/wire";
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
type Watched = Pick<
  RolloutSummaryWire,
  "id" | "flagKey" | "workloadName" | "environmentId"
>;

export function finishedSince(
  previous: readonly Watched[],
  current: readonly { id: string }[],
): Watched[] {
  const still = new Set(current.map((r) => r.id));
  return previous.filter((r) => !still.has(r.id));
}

/** [Plan #58 UX-9] Tên người đọc được: key flag, hoặc workload với rollout theo phiên bản; mã chỉ là đường lui cuối */
export const watchedName = (r: Watched): string =>
  r.flagKey ?? r.workloadName ?? r.id.slice(0, 8);

export function useRolloutWatcher(projectId: string): void {
  const navigate = useNavigate();
  // Nhớ kèm project: sang project khác thì danh sách cũ không được coi là "vừa kết thúc"
  const prev = useRef<{ projectId: string; list: Watched[] } | null>(null);
  const active = useQuery({
    queryKey: qk.activeRollouts(projectId),
    queryFn: () => rolloutApi.active(projectId),
    refetchInterval: 15_000,
  });

  useEffect(() => {
    const now = active.data?.rollouts;
    if (now === undefined) return;
    if (prev.current?.projectId === projectId) {
      // Chữ đọc lúc sự kiện xảy ra: hook này không vẽ gì nên không theo dõi ngôn ngữ
      const m = messagesOf(rolloutMessages).watcher;
      for (const r of finishedSince(prev.current.list, now)) {
        // [Plan #58 UX-9] Nút "Xem kết quả" mở đúng rollout đó, ở đúng environment của nó
        toast.action(m.finished(watchedName(r)), {
          label: m.view,
          run: () =>
            void navigate({
              to: "/app/projects/$projectId/rollouts/$rolloutId",
              params: { projectId, rolloutId: r.id },
              search: { env: r.environmentId },
            }),
        });
      }
    }
    prev.current = {
      projectId,
      list: now.map((r) => ({
        id: r.id,
        flagKey: r.flagKey,
        workloadName: r.workloadName,
        environmentId: r.environmentId,
      })),
    };
  }, [active.data, navigate, projectId]);
}
