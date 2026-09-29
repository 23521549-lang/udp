import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { AdminUserWire } from "@udp/shared-types/wire";
import { useState } from "react";
import { ConfirmDialog } from "../../../components/ConfirmDialog";
import { Empty, ErrorState, Loading } from "../../../components/States";
import { toast } from "../../../components/Toast";
import { messageOf } from "../../../lib/errors";
import { formatDateTime } from "../../../lib/format";
import { qk, qkPrefix } from "../../../lib/query-keys";
import { useAuthStore } from "../../auth/auth-store";
import { adminApi } from "../admin-api";

import { AdminPage } from "../AdminLayout";
export function AdminUsersPage() {
  const me = useAuthStore((s) => s.user);
  const queryClient = useQueryClient();
  const [search, setSearch] = useState("");
  const [pending, setPending] = useState<AdminUserWire | null>(null);
  const users = useQuery({
    queryKey: qk.adminUsers(search.trim()),
    queryFn: () =>
      adminApi.users(search.trim() === "" ? undefined : search.trim()),
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
    >
      <div className="filters" style={{ padding: "0 0 10px" }}>
        <input
          className="inp"
          aria-label="Tìm người dùng"
          placeholder="Tìm theo email hoặc tên…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>
      {users.isPending ? (
        <Loading />
      ) : users.isError ? (
        <ErrorState error={users.error} onRetry={() => void users.refetch()} />
      ) : users.data.users.length === 0 ? (
        <Empty title="Không có ai khớp" />
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
                  <th scope="row">{u.email}</th>
                  <td>{u.name}</td>
                  <td>
                    {u.platformRole === "PLATFORM_ADMIN"
                      ? "Quản trị"
                      : "Người dùng"}
                  </td>
                  <td>{formatDateTime(u.createdAt)}</td>
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
      {pending !== null && (
        <ConfirmDialog
          title={
            pending.platformRole === "PLATFORM_ADMIN"
              ? `Hạ quyền ${pending.email}?`
              : `Cho ${pending.email} quyền quản trị?`
          }
          description={
            pending.id === me?.id
              ? "Đây là chính bạn: sau khi hạ, bạn không vào lại được khu quản trị."
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
