import { useQueries } from "@tanstack/react-query";
import { qk } from "../../lib/query-keys";
import { flagApi } from "./flag-api";

/**
 * [Plan #41] Ba con số của MỘT env — tổng, đang bật, nháp — mỗi số một lời `limit=1` đọc `total`,
 * không tải danh sách. Key nằm dưới họ `flags` nên mọi lần invalidate danh sách làm mới luôn số.
 */
export function useFlagCounts(projectId: string, envId: string) {
  const [total, enabled, drafts] = useQueries({
    queries: (
      [{}, { isEnabled: true }, { status: "DRAFT" as const }] as const
    ).map((filter) => ({
      queryKey: qk.flags(projectId, envId, "count", filter),
      queryFn: () => flagApi.count(projectId, envId, filter),
      staleTime: 10_000,
    })),
  });
  return {
    total: total?.data,
    enabled: enabled?.data,
    drafts: drafts?.data,
  };
}
