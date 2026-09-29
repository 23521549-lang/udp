import {
  keepPreviousData,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useNavigate, useSearch } from "@tanstack/react-router";
import type { AdminUserWire } from "@udp/shared-types/wire";
import { Search } from "lucide-react";
import { useCallback, useState } from "react";
import { ConfirmDialog } from "../../../components/ConfirmDialog";
import { Icon } from "../../../components/Icon";
import { Pager } from "../../../components/Pager";
import { Empty, ErrorState, Loading } from "../../../components/States";
import { toast } from "../../../components/Toast";
import { messageOf } from "../../../lib/errors";
import { formatDateTime } from "../../../lib/format";
import { qk, qkPrefix } from "../../../lib/query-keys";
import { useSearchInput } from "../../../lib/use-search-input";
import { useAuthStore } from "../../auth/auth-store";
import { ADMIN_PAGE_SIZE, adminApi } from "../admin-api";
import { AdminPage } from "../AdminLayout";

/**
 * Người dùng (§10.11). Từ khoá và trang trên URL (Plan #53 QĐ-9); theo trang ở máy chủ với `total`,
 * nên người dùng thứ 101 trở đi không còn bị cắt im lặng.
 */
export function AdminUsersPage() {
  const me = useAuthStore((s) => s.user);
  const queryClient = useQueryClient();
  const search = useSearch({ from: "/admin/users" });
  const navigate = useNavigate({ from: "/admin/users" });
  const term = (search.q ?? "").trim();
  const offset = search.offset ?? 0;
  const commitTerm = useCallback(
    (next: string) => {
      void navigate({
        replace: true,
        search: next === "" ? {} : { q: next },
      });
    },
    [navigate],
  );
  const [q, setQ] = useSearchInput(term, commitTerm);
  const setOffset = (n: number): void => {
    void navigate({
      search: (prev) => {
        const { offset: _o, ...rest } = prev;
        return n === 0 ? rest : { ...rest, offset: n };
      },
    });
  };

  const [pending, setPending] = useState<AdminUserWire | null>(null);
  const users = useQuery({
    queryKey: qk.adminUsers(term, offset),
    queryFn: () => adminApi.users(term === "" ? undefined : term, offset),
    placeholderData: keepPreviousData,
  });
  const setRole = useMutation({
    mutationFn: (u: AdminUserWire) =>
      adminApi.setRole(
        u.id,
        u.platformRole === "PLATFORM_ADMIN" ? "USER" : "PLATFORM_ADMIN",
      ),
    onSuccess: async () => {
      setPending(null);
      toast.info("Đã đổi vai");
      await queryClient.invalidateQueries({
        queryKey: qkPrefix.adminUsersAll(),
      });
    },
  });

  return (
    <AdminPage
      title="Người dùng"
      lead="Vai toàn hệ thống. Quyền trong từng project do chủ project quản lý."
      minis={
        users.data === undefined
          ? undefined
          : [
              {
                value: users.data.total,
                label: term === "" ? "người dùng" : "khớp",
              },
            ]
      }
    >
      <div className="filters flush">
        <label className="q">
          <Icon of={Search} />
          <input
            type="search"
            name="q"
            aria-label="Tìm người dùng"
            placeholder="Tìm theo email hoặc tên…"
            autoComplete="off"
            spellCheck={false}
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
        </label>
      </div>
      {users.isPending ? (
        <Loading />
      ) : users.isError ? (
        <ErrorState error={users.error} onRetry={() => void users.refetch()} />
      ) : users.data.users.length === 0 ? (
        <Empty title="Không có ai khớp">Thử từ khoá khác.</Empty>
      ) : (
        <div className="table-wrap">
          <table className="dtable" aria-label="Người dùng">
            <thead>
              <tr>
                <th scope="col">Email</th>
                <th scope="col">Tên</th>
                <th scope="col">Vai</th>
                <th scope="col">Tạo lúc</th>
                <th scope="col">
                  <span className="visually-hidden">Hành động</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {users.data.users.map((u) => (
                <tr key={u.id}>
                  <th scope="row" translate="no">
                    {u.email}
                  </th>
                  <td>{u.name}</td>
                  <td>
                    {u.platformRole === "PLATFORM_ADMIN"
                      ? "Quản trị"
                      : "Người dùng"}
                  </td>
                  <td className="num">{formatDateTime(u.createdAt)}</td>
                  <td>
                    <button
                      type="button"
                      className="btn"
                      onClick={() => setPending(u)}
                    >
                      {u.platformRole === "PLATFORM_ADMIN"
                        ? "Hạ quyền"
                        : "Nâng quản trị"}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <Pager
        label="Trang của danh sách người dùng"
        offset={offset}
        pageSize={ADMIN_PAGE_SIZE}
        total={users.data?.total ?? 0}
        onChange={setOffset}
      />
      {pending !== null && (
        <ConfirmDialog
          title={
            pending.platformRole === "PLATFORM_ADMIN"
              ? `Hạ quyền ${pending.email}?`
              : `Cho ${pending.email} quyền quản trị?`
          }
          description={
            pending.id === me?.id
              ? "Đây là chính bạn: sau khi hạ, bạn không vào lại được Bảng điều khiển."
              : "Có hiệu lực ngay ở request kế tiếp của người đó."
          }
          confirmLabel="Đổi vai"
          danger={pending.platformRole === "PLATFORM_ADMIN"}
          typeToConfirm={pending.email}
          busy={setRole.isPending}
          error={setRole.isError ? messageOf(setRole.error) : undefined}
          onConfirm={() => setRole.mutate(pending)}
          onClose={() => {
            setPending(null);
            setRole.reset();
          }}
        />
      )}
    </AdminPage>
  );
}
