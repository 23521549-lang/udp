import { useQuery } from "@tanstack/react-query";
import { ErrorState, Loading } from "../../../components/States";
import { StatusLabel } from "../../../components/StatusLabel";
import { useMessages } from "../../../i18n";
import { formatDateTime } from "../../../lib/format";
import { qk } from "../../../lib/query-keys";
import { adminApi } from "../admin-api";
import { adminMessages } from "../admin.messages";
import { AdminPage } from "../AdminLayout";
import { serviceStatus } from "../platform-model";

/** Sức khoẻ ba service và database (§10.11), tự cập nhật mỗi 30 giây */
export function AdminSystemPage() {
  const m = useMessages(adminMessages).system;
  const system = useQuery({
    queryKey: qk.adminSystem(),
    queryFn: adminApi.system,
    refetchInterval: 30_000,
  });
  return (
    <AdminPage title={m.title} lead={m.lead}>
      {system.isPending ? (
        <Loading />
      ) : system.isError ? (
        <ErrorState
          error={system.error}
          onRetry={() => void system.refetch()}
        />
      ) : (
        <ul className="lst" aria-label={m.health}>
          {[
            ...system.data.services,
            { name: "database", status: system.data.database },
          ].map((s) => {
            const health = serviceStatus(s.status);
            return (
              <li key={s.name} className="it">
                <span className="mono" translate="no">
                  {s.name}
                </span>
                <span className="lst-end">
                  <StatusLabel tone={health.tone}>{health.label}</StatusLabel>
                </span>
              </li>
            );
          })}
          <li className="it c3">
            {m.checkedAt(formatDateTime(system.data.checkedAt))}
          </li>
        </ul>
      )}
    </AdminPage>
  );
}
