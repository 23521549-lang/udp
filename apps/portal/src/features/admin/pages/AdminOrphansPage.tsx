import { useQuery } from "@tanstack/react-query";
import { CircleAlert, PiggyBank } from "lucide-react";
import { Icon } from "../../../components/Icon";
import { Empty, ErrorState, Loading } from "../../../components/States";
import { formatNumber } from "../../../lib/format";
import { qk } from "../../../lib/query-keys";
import { adminApi } from "../admin-api";

import { AdminPage } from "../AdminLayout";
/**
 * Màn hình DUY NHẤT nhìn thấy tiền đang bị đốt (§10.13). `null` USD/giờ nghĩa là không
 * định giá được — hiện "chưa rõ giá", tuyệt đối không hiện 0.
 */
export function AdminOrphansPage() {
  const orphans = useQuery({
    queryKey: qk.adminOrphans(),
    queryFn: adminApi.orphans,
  });
  const d = orphans.data;
  return (
    <AdminPage
      title="Tài nguyên mồ côi"
      lead="Tài nguyên cloud không dọn được sau teardown, kèm chi phí đang chạy."
      icon={PiggyBank}
    >
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
              <div className="l">Đang đốt</div>
              <div className="v num">
                ${formatNumber(d.estimatedUsdPerHour)}
                <small>/giờ</small>
              </div>
            </div>
            <div>
              <div className="l">Mỗi ngày</div>
              <div className="v num">
                $
                {formatNumber(
                  Math.round(d.estimatedUsdPerHour * 24 * 100) / 100,
                )}
              </div>
            </div>
            <div>
              <div className="l">Tài nguyên</div>
              <div className="v num">{d.resources.length}</div>
            </div>
            <div>
              <div className="l">Chưa rõ giá</div>
              <div className="v num">{d.unpriced.length}</div>
            </div>
          </div>
          {!d.cloudScanned && (
            <div className="alert amber" role="status">
              <Icon of={CircleAlert} />
              <div>
                Danh sách theo SỔ tài nguyên. Chưa quét cloud theo tag, nên tài
                nguyên có tag của UDP mà không có trong sổ chưa hiện ở đây. Bảng
                giá ngày {d.pricingAsOf}.
              </div>
            </div>
          )}
          {d.resources.length === 0 ? (
            <Empty title="Không có tài nguyên mồ côi nào trong sổ" />
          ) : (
            <div className="table-wrap">
              <table className="matrix" aria-label="Tài nguyên mồ côi">
                <thead>
                  <tr>
                    <th scope="col">Project</th>
                    <th scope="col">Loại</th>
                    <th scope="col">Vùng</th>
                    <th scope="col">Id trên cloud</th>
                    <th scope="col">USD/giờ</th>
                  </tr>
                </thead>
                <tbody>
                  {d.resources.map((r) => (
                    <tr key={r.id}>
                      <th scope="row">{r.projectName}</th>
                      <td className="mono">{r.kind}</td>
                      <td>
                        {r.provider} {r.region}
                      </td>
                      <td className="mono">{r.providerId ?? "chưa biết"}</td>
                      <td className="num">
                        {r.usdPerHour === null
                          ? "chưa rõ giá"
                          : `$${String(r.usdPerHour)}`}
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
