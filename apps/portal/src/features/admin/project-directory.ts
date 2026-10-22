import { useQueries, useQuery } from "@tanstack/react-query";
import { qk } from "../../lib/query-keys";
import { ADMIN_PAGE_SIZE, adminApi, type AdminProjectRow } from "./admin-api";

/** Danh bạ ít đổi trong một phiên xem: mở panel hay đổi trang không tải lại mỗi lần */
const DIRECTORY_STALE_MS = 60_000;

const page = (offset: number) => ({
  queryKey: qk.adminProjects({}, offset),
  queryFn: () => adminApi.projects({}, offset),
  staleTime: DIRECTORY_STALE_MS,
});

export interface ProjectDirectory {
  byId: ReadonlyMap<string, AdminProjectRow>;
  isPending: boolean;
  isError: boolean;
  error: unknown;
  refetch: () => void;
}

/**
 * [Plan #58 UX-32, UX-33] Mọi project của nền tảng theo id — chủ của tài nguyên mồ côi, và trạng thái/chủ trong panel
 * project mở từ Job lỗi hay Tài nguyên mồ côi (hai danh sách đó chỉ có id và tên). Đi qua CHÍNH các trang không lọc
 * của `GET /admin/projects` (cùng query key với trang Project), nên không thêm route nào ở máy chủ; ở quy mô một máy
 * Always Free (vài chục project) đó là một request.
 */
export function useProjectDirectory(): ProjectDirectory {
  const first = useQuery(page(0));
  const total = first.data?.total ?? 0;
  const offsets: number[] = [];
  for (let o = ADMIN_PAGE_SIZE; o < total; o += ADMIN_PAGE_SIZE)
    offsets.push(o);
  const rest = useQueries({ queries: offsets.map(page) });
  const pages = [first, ...rest];
  const failed = pages.find((p) => p.isError);
  return {
    byId: new Map(
      pages.flatMap((p) => p.data?.projects ?? []).map((p) => [p.id, p]),
    ),
    isPending: pages.some((p) => p.isPending),
    isError: failed !== undefined,
    error: failed?.error,
    refetch: () => {
      for (const p of pages) if (p.isError) void p.refetch();
    },
  };
}
