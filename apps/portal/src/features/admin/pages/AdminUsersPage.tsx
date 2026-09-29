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
import { useMessages } from "../../../i18n";
import { messageOf } from "../../../lib/errors";
import { formatDateTime } from "../../../lib/format";
import { qk, qkPrefix } from "../../../lib/query-keys";
import { useSearchInput } from "../../../lib/use-search-input";
import { useAuthStore } from "../../auth/auth-store";
import { ADMIN_PAGE_SIZE, adminApi } from "../admin-api";
import { adminMessages } from "../admin.messages";
import { AdminPage } from "../AdminLayout";

/**
 * Người dùng (§10.11). Từ khoá và trang trên URL (Plan #53 QĐ-9); theo trang ở máy chủ với `total`,
 * nên người dùng thứ 101 trở đi không còn bị cắt im lặng.
 */
export function AdminUsersPage() {
  const t = useMessages(adminMessages);
  const m = t.users;
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
      toast.info(m.changed);
      await queryClient.invalidateQueries({
        queryKey: qkPrefix.adminUsersAll(),
      });
    },
  });

  return (
    <AdminPage
      title={m.title}
      lead={m.lead}
      minis={
        users.data === undefined
          ? undefined
          : [
              {
                value: users.data.total,
                label:
                  term === ""
                    ? m.count(users.data.total)
                    : m.matches(users.data.total),
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
            aria-label={m.search}
            placeholder={m.searchPlaceholder}
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
        <Empty title={m.empty}>{m.emptyHint}</Empty>
      ) : (
        <div className="table-wrap">
          <table className="dtable" aria-label={m.table}>
            <thead>
              <tr>
                <th scope="col">{m.email}</th>
                <th scope="col">{m.name}</th>
                <th scope="col">{m.role}</th>
                <th scope="col">{t.created}</th>
                <th scope="col">
                  <span className="visually-hidden">{m.actions}</span>
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
                    {u.platformRole === "PLATFORM_ADMIN" ? m.admin : m.user}
                  </td>
                  <td className="num">{formatDateTime(u.createdAt)}</td>
                  <td>
                    <button
                      type="button"
                      className="btn"
                      onClick={() => setPending(u)}
                    >
                      {u.platformRole === "PLATFORM_ADMIN"
                        ? m.revoke
                        : m.promote}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <Pager
        label={m.pager}
        offset={offset}
        pageSize={ADMIN_PAGE_SIZE}
        total={users.data?.total ?? 0}
        onChange={setOffset}
      />
      {pending !== null && (
        <ConfirmDialog
          title={
            pending.platformRole === "PLATFORM_ADMIN"
              ? m.confirmRevoke(pending.email)
              : m.confirmPromote(pending.email)
          }
          description={pending.id === me?.id ? m.self : m.nextRequest}
          confirmLabel={m.confirm}
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
