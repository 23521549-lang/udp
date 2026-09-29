import { useQuery } from "@tanstack/react-query";
import { CircleAlert } from "lucide-react";
import { Icon } from "../../../components/Icon";
import { Empty, ErrorState, Loading } from "../../../components/States";
import { useMessages } from "../../../i18n";
import { formatUsd } from "../../../lib/format";
import { qk } from "../../../lib/query-keys";
import { PROVIDER_LABEL } from "../../project/cloud/cloud-labels";
import { adminApi } from "../admin-api";
import { adminMessages } from "../admin.messages";
import { AdminPage } from "../AdminLayout";

/**
 * Màn hình DUY NHẤT nhìn thấy tiền đang bị đốt (§10.13). `null` USD/giờ nghĩa là không
 * định giá được — hiện "chưa rõ giá", tuyệt đối không hiện 0.
 */
export function AdminOrphansPage() {
  const t = useMessages(adminMessages);
  const m = t.orphans;
  const orphans = useQuery({
    queryKey: qk.adminOrphans(),
    queryFn: adminApi.orphans,
  });
  const d = orphans.data;
  return (
    <AdminPage title={m.title} lead={m.lead}>
      {orphans.isPending ? (
        <Loading />
      ) : orphans.isError ? (
        <ErrorState
          error={orphans.error}
          onRetry={() => void orphans.refetch()}
        />
      ) : d === undefined ? null : (
        <>
          <div className="stat">
            <div>
              <div className="l">{m.burning}</div>
              <div className="v num">
                {formatUsd(d.estimatedUsdPerHour)}
                <small>{m.perHourUnit}</small>
              </div>
            </div>
            <div>
              <div className="l">{m.perDay}</div>
              <div className="v num">
                {formatUsd(d.estimatedUsdPerHour * 24)}
              </div>
            </div>
            <div>
              <div className="l">{m.resources}</div>
              <div className="v num">{d.resources.length}</div>
            </div>
            <div>
              <div className="l">{m.unpriced}</div>
              <div className="v num">{d.unpriced.length}</div>
            </div>
          </div>
          {!d.cloudScanned && (
            <div className="alert amber" role="status">
              <Icon of={CircleAlert} />
              <div>{m.notScanned(d.pricingAsOf)}</div>
            </div>
          )}
          {d.resources.length === 0 ? (
            <Empty title={m.empty} />
          ) : (
            <div className="table-wrap">
              <table className="dtable" aria-label={m.title}>
                <thead>
                  <tr>
                    <th scope="col">{t.project}</th>
                    <th scope="col">{m.kind}</th>
                    <th scope="col">{m.region}</th>
                    <th scope="col">{m.cloudId}</th>
                    <th scope="col" className="num">
                      {m.usdPerHour}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {d.resources.map((r) => (
                    <tr key={r.id}>
                      <th scope="row">{r.projectName}</th>
                      <td className="mono" translate="no">
                        {r.kind}
                      </td>
                      <td>
                        {PROVIDER_LABEL[r.provider]}{" "}
                        <span className="mono" translate="no">
                          {r.region}
                        </span>
                      </td>
                      <td className="mono" translate="no">
                        {r.providerId ?? m.unknownId}
                      </td>
                      <td className="num">
                        {r.usdPerHour === null
                          ? m.unpriced
                          : formatUsd(r.usdPerHour)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </AdminPage>
  );
}
