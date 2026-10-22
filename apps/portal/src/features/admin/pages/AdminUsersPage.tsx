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
import {
  ADMIN_ROLES,
  CREATED_DEFAULT,
  CREATED_SORTS,
  setParam,
  type AdminRole,
} from "../admin-search";
import { adminMessages } from "../admin.messages";
import { AdminPage } from "../AdminLayout";
import { SortHeader } from "../SortHeader";
import { parseSort, sortParam, toggleSort } from "../sort";

/**
 * Người dùng (§10.11). Từ khoá và trang trên URL (Plan #53 QĐ-9); theo trang ở máy chủ với `total`,
 * nên người dùng thứ 101 trở đi không còn bị cắt im lặng.
 *
 * [Plan #58 UX-34, UX-36] Lọc theo vai (`?role=PLATFORM_ADMIN` là danh sách quản trị), sắp theo ngày tạo. Đổi vai nói
 * đúng động từ ở nút, nút xác nhận và thông báo; "Hạ quyền" mang dáng nguy hiểm; dòng của chính mình ghi "(bạn)".
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
  const sort = parseSort(search.sort, CREATED_SORTS) ?? CREATED_DEFAULT;
  const filter = {
    search: term === "" ? undefined : term,
    platformRole: search.role,
    order: sort.dir === "asc" ? ("asc" as const) : undefined,
  };
  const filtered =
    filter.search !== undefined || filter.platformRole !== undefined;
  const commitTerm = useCallback(
    (next: string) => {
      void navigate({
        replace: true,
        search: (prev) =>
          setParam(
            setParam(prev, "offset", undefined),
            "q",
            next === "" ? undefined : next,
          ),
      });
    },
    [navigate],
  );
  const [q, setQ] = useSearchInput(term, commitTerm);
  const setOffset = (n: number): void => {
    void navigate({
      search: (prev) => setParam(prev, "offset", n === 0 ? undefined : n),
    });
  };
  const setRoleFilter = (role: AdminRole | undefined): void => {
    void navigate({
      search: (prev) =>
        setParam(setParam(prev, "offset", undefined), "role", role),
    });
  };
  const onSort = (): void => {
    const next = toggleSort(sort, "created", "desc");
    void navigate({
      search: (prev) =>
        setParam(
          setParam(prev, "offset", undefined),
          "sort",
          sortParam(next, CREATED_DEFAULT),
        ),
      replace: true,
    });
  };

  const [pending, setPending] = useState<AdminUserWire | null>(null);
  const users = useQuery({
    queryKey: qk.adminUsers(filter, offset),
    queryFn: () => adminApi.users(filter, offset),
    placeholderData: keepPreviousData,
  });
  const setRole = useMutation({
    mutationFn: (u: AdminUserWire) =>
      adminApi.setRole(
        u.id,
        u.platformRole === "PLATFORM_ADMIN" ? "USER" : "PLATFORM_ADMIN",
      ),
    onSuccess: async ({ user }) => {
      setPending(null);
      const name = user.name.trim() === "" ? user.email : user.name;
      toast.info(
        user.platformRole === "PLATFORM_ADMIN"
          ? m.promoted(name)
          : m.revoked(name),
      );
      await queryClient.invalidateQueries({
        queryKey: qkPrefix.adminUsersAll(),
      });
    },
  });
  const revoking = pending?.platformRole === "PLATFORM_ADMIN";

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
                label: filtered
                  ? m.matches(users.data.total)
                  : m.count(users.data.total),
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
        <div className="seg" role="group" aria-label={m.roleFilter}>
          <button
            type="button"
            aria-pressed={search.role === undefined}
            onClick={() => setRoleFilter(undefined)}
          >
            {m.allRoles}
          </button>
          {ADMIN_ROLES.map((r) => (
            <button
              key={r}
              type="button"
              aria-pressed={search.role === r}
              onClick={() => setRoleFilter(r)}
            >
              {r === "PLATFORM_ADMIN" ? m.admin : m.user}
            </button>
          ))}
        </div>
      </div>
      {users.isPending ? (
        <Loading />
      ) : users.isError ? (
        <ErrorState error={users.error} onRetry={() => void users.refetch()} />
      ) : users.data.users.length === 0 ? (
        <Empty title={m.empty}>
          {m.emptyHint}{" "}
          {filtered && (
            <button
              type="button"
              className="btn"
              onClick={() => {
                setQ("");
                void navigate({ search: {} });
              }}
            >
              {t.clearFilters}
            </button>
          )}
        </Empty>
      ) : (
        <div className="table-wrap">
          <table className="dtable" aria-label={m.table}>
            <thead>
              <tr>
                <th scope="col">{m.email}</th>
                <th scope="col">{m.role}</th>
                <th scope="col">{m.name}</th>
                <SortHeader
                  label={t.created}
                  column="created"
                  sort={sort}
                  onSort={onSort}
                />
                <th scope="col">
                  <span className="visually-hidden">{m.actions}</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {users.data.users.map((u) => {
                const admin = u.platformRole === "PLATFORM_ADMIN";
                return (
                  <tr key={u.id}>
                    <th scope="row">
                      <span translate="no">{u.email}</span>
                      {u.id === me?.id && (
                        <span className="c3 you"> {t.you}</span>
                      )}
                    </th>
                    <td>{admin ? m.admin : m.user}</td>
                    <td translate="no">{u.name}</td>
                    <td className="num">{formatDateTime(u.createdAt)}</td>
                    <td>
                      <button
                        type="button"
                        className={admin ? "btn danger" : "btn"}
                        onClick={() => setPending(u)}
                      >
                        {admin ? m.revoke : m.promote}
                      </button>
                    </td>
                  </tr>
                );
              })}
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
            revoking
              ? m.confirmRevoke(pending.email)
              : m.confirmPromote(pending.email)
          }
          description={pending.id === me?.id ? m.self : m.nextRequest}
          confirmLabel={revoking ? m.revoke : m.promote}
          danger={revoking}
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
