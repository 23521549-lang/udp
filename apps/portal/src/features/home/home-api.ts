import { useQuery } from "@tanstack/react-query";
import { homeResponseWire } from "@udp/shared-types/wire";
import { useMemo } from "react";
import { api } from "../../lib/http";
import { qk } from "../../lib/query-keys";

/** [Plan #53 QĐ-5] Trang chủ: mọi project của người dùng trong MỘT lời gọi */
export const homeApi = {
  get: () => api(homeResponseWire, "/home"),
};

/**
 * [Plan #58 UX-5] Số việc cần xử lý theo project, đọc từ CHÍNH `GET /home` của trang chủ (cùng query key, nên từ
 * trang chủ sang không tốn thêm lời gọi). `undefined` khi chưa có số.
 */
export function useAttentionByProject():
  ReadonlyMap<string, number> | undefined {
  const home = useQuery({
    queryKey: qk.home(),
    queryFn: homeApi.get,
    staleTime: 30_000,
  });
  const projects = home.data?.home.projects;
  return useMemo(
    () =>
      projects === undefined
        ? undefined
        : new Map(projects.map((p) => [p.id, p.attention])),
    [projects],
  );
}
