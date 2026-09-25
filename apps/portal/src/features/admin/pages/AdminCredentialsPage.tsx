import { useQuery } from "@tanstack/react-query";
import { KeyRound } from "lucide-react";
import { Empty, ErrorState, Loading } from "../../../components/States";
import { formatDateTime } from "../../../lib/format";
import { qk } from "../../../lib/query-keys";
import { adminApi } from "../admin-api";

import { AdminPage } from "../AdminLayout";
export function AdminCredentialsPage() {
  const creds = useQuery({
    queryKey: qk.adminCredentials(),
    queryFn: adminApi.credentials,
  });
  return (
    <AdminPage
      title="Credential"
      lead="Chỉ siêu dữ liệu và một đoạn dấu vân tay. Nội dung credential không bao giờ được giải mã để hiển thị."
      icon={KeyRound}
    >
      {creds.isPending ? (
        <Loading />
      ) : creds.isError ? (
        <ErrorState error={creds.error} onRetry={() => void creds.refetch()} />
      ) : creds.data.credentials.length === 0 ? (
        <Empty title="Chưa có credential nào" />
      ) : (
        <div className="table-wrap">
          <table className="matrix" aria-label="Credential">
            <thead>
              <tr>
                <th scope="col">Project</th>
                <th scope="col">Cloud</th>
                <th scope="col">Chế độ</th>
                <th scope="col">Dấu vân tay</th>
                <th scope="col">Đang dùng</th>
                <th scope="col">Kiểm lần cuối</th>
              </tr>
            </thead>
            <tbody>
              {creds.data.credentials.map((c) => (
                <tr key={c.id}>
                  <th scope="row">{c.project.name}</th>
                  <td>{c.provider}</td>
                  <td>{c.mode}</td>
                  <td className="mono">{c.fingerprint}…</td>
                  <td>{c.isActive ? "Có" : "–"}</td>
                  <td>
                    {c.lastValidatedAt === null
                      ? "chưa"
                      : formatDateTime(c.lastValidatedAt)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </AdminPage>
  );
}
