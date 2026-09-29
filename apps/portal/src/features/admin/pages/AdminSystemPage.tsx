import { useQuery } from "@tanstack/react-query";
import { ErrorState, Loading } from "../../../components/States";
import { StatusLabel } from "../../../components/StatusLabel";
import { formatDateTime } from "../../../lib/format";
import { qk } from "../../../lib/query-keys";
import { adminApi } from "../admin-api";
import { AdminPage } from "../AdminLayout";
import { SERVICE_STATUS } from "../platform-model";

/** Sức khoẻ ba service và database (§10.11), tự cập nhật mỗi 30 giây */
export function AdminSystemPage() {
  const system = useQuery({
    queryKey: qk.adminSystem(),
    queryFn: adminApi.system,
    refetchInterval: 30_000,
  });
  return (
    <AdminPage
      title="Hệ thống"
      lead="Sức khoẻ ba service và database, tự cập nhật mỗi 30 giây."
    >
      {system.isPending ? (
        <Loading />
      ) : system.isError ? (
        <ErrorState
          error={system.error}
          onRetry={() => void system.refetch()}
        />
      ) : (
        <ul className="lst" aria-label="Sức khoẻ">
          {[
            ...system.data.services,
            { name: "database", status: system.data.database },
          ].map((s) => (
            <li key={s.name} className="it">
              <span className="mono" translate="no">
                {s.name}
              </span>
              <span className="lst-end">
                <StatusLabel tone={SERVICE_STATUS[s.status].tone}>
                  {SERVICE_STATUS[s.status].label}
                </StatusLabel>
              </span>
            </li>
          ))}
          <li className="it c3">
            Kiểm lúc {formatDateTime(system.data.checkedAt)}
          </li>
        </ul>
      )}
    </AdminPage>
  );
}
