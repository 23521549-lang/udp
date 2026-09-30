import { useQuery } from "@tanstack/react-query";
import { ErrorState, Loading } from "../../../components/States";
import { useMessages } from "../../../i18n";
import { qk } from "../../../lib/query-keys";
import { domainApi } from "../../domain/domain-api";
import { tierLabel } from "../../domain/domain-labels";
import { adminMessages } from "../admin.messages";
import { AdminPage } from "../AdminLayout";

/**
 * Catalog domain (§10.13 "Admin: Domain Catalog") — CHỈ ĐỌC: bảng do registry đồng bộ lúc
 * khởi động (I29), không endpoint nào sửa nó. Trang này cho thấy registry đã nạp những gì.
 */
export function AdminCatalogPage() {
  const m = useMessages(adminMessages);
  const catalog = useQuery({
    queryKey: qk.catalog(),
    queryFn: domainApi.catalog,
    staleTime: Infinity,
  });
  return (
    <AdminPage title={m.catalog.title} lead={m.catalog.lead}>
      {catalog.isPending ? (
        <Loading />
      ) : catalog.isError ? (
        <ErrorState
          error={catalog.error}
          onRetry={() => void catalog.refetch()}
        />
      ) : (
        // [Plan #58 UX-41] Bảng rộng không chứa gì bấm được: vùng cuộn nhận focus để bàn phím cuộn được (WCAG 2.1.1)
        <div
          className="table-wrap"
          tabIndex={0}
          role="region"
          aria-label={m.catalog.title}
        >
          <table className="dtable" aria-label={m.catalog.title}>
            <thead>
              <tr>
                <th scope="col">{m.domain}</th>
                <th scope="col">{m.catalog.tier}</th>
                <th scope="col">{m.catalog.available}</th>
                <th scope="col">{m.catalog.tools}</th>
              </tr>
            </thead>
            <tbody>
              {catalog.data.domains.map((d) => (
                <tr key={d.domainType}>
                  <th scope="row">{d.displayName}</th>
                  <td>{tierLabel(d.tier)}</td>
                  <td>{d.isAvailable ? m.yes : m.catalog.removed}</td>
                  <td className="mono">
                    {d.tools.length === 0
                      ? "–"
                      : d.tools
                          .map((t) => `${t.toolId} ${t.version}`)
                          .join(", ")}
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
