import { useQuery } from "@tanstack/react-query";
import { ErrorState, Loading } from "../../../components/States";
import { qk } from "../../../lib/query-keys";
import { domainApi } from "../../domain/domain-api";
import { tierLabel } from "../../domain/domain-labels";
import { AdminPage } from "../AdminLayout";

/**
 * Catalog domain (§10.13 "Admin: Domain Catalog") — CHỈ ĐỌC: bảng do registry đồng bộ lúc
 * khởi động (I29), không endpoint nào sửa nó. Trang này cho thấy registry đã nạp những gì.
 */
export function AdminCatalogPage() {
  const catalog = useQuery({
    queryKey: qk.catalog(),
    queryFn: domainApi.catalog,
    staleTime: Infinity,
  });
  return (
    <AdminPage
      title="Catalog domain"
      lead="Danh mục domain và công cụ mà máy chủ nạp được từ thư mục adapter. Chỉ đọc."
    >
      {catalog.isPending ? (
        <Loading />
      ) : catalog.isError ? (
        <ErrorState
          error={catalog.error}
          onRetry={() => void catalog.refetch()}
        />
      ) : (
        <div className="table-wrap">
          <table className="dtable" aria-label="Catalog domain">
            <thead>
              <tr>
                <th scope="col">Domain</th>
                <th scope="col">Bậc</th>
                <th scope="col">Dùng được</th>
                <th scope="col">Công cụ</th>
              </tr>
            </thead>
            <tbody>
              {catalog.data.domains.map((d) => (
                <tr key={d.domainType}>
                  <th scope="row">{d.displayName}</th>
                  <td>{tierLabel(d.tier)}</td>
                  <td>{d.isAvailable ? "Có" : "Đã gỡ"}</td>
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
