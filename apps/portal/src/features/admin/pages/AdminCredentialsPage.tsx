import { useQuery } from "@tanstack/react-query";
import { Empty, ErrorState, Loading } from "../../../components/States";
import { useMessages } from "../../../i18n";
import { formatDateTime } from "../../../lib/format";
import { qk } from "../../../lib/query-keys";
import { adminApi } from "../admin-api";
import { adminMessages } from "../admin.messages";

import { AdminPage } from "../AdminLayout";
export function AdminCredentialsPage() {
  const m = useMessages(adminMessages);
  const creds = useQuery({
    queryKey: qk.adminCredentials(),
    queryFn: adminApi.credentials,
  });
  return (
    <AdminPage title={m.credentials.title} lead={m.credentials.lead}>
      {creds.isPending ? (
        <Loading />
      ) : creds.isError ? (
        <ErrorState error={creds.error} onRetry={() => void creds.refetch()} />
      ) : creds.data.credentials.length === 0 ? (
        <Empty title={m.credentials.empty} />
      ) : (
        <div className="table-wrap">
          <table className="dtable" aria-label={m.credentials.title}>
            <thead>
              <tr>
                <th scope="col">{m.project}</th>
                <th scope="col">{m.cloud}</th>
                <th scope="col">{m.credentials.mode}</th>
                <th scope="col">{m.credentials.fingerprint}</th>
                <th scope="col">{m.credentials.active}</th>
                <th scope="col">{m.credentials.lastValidated}</th>
              </tr>
            </thead>
            <tbody>
              {creds.data.credentials.map((c) => (
                <tr key={c.id}>
                  <th scope="row">{c.project.name}</th>
                  <td>{c.provider}</td>
                  <td>{c.mode}</td>
                  <td className="mono">{c.fingerprint}…</td>
                  <td>{c.isActive ? m.yes : "–"}</td>
                  <td>
                    {c.lastValidatedAt === null
                      ? m.credentials.never
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
