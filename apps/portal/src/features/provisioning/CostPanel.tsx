import { useQuery } from "@tanstack/react-query";
import { DOMAIN_ERROR_SLUGS } from "@udp/shared-types/domain-api";
import { useState } from "react";
import { Empty, ErrorState, Loading } from "../../components/States";
import { problemSlugOf } from "../../lib/errors";
import { qk } from "../../lib/query-keys";
import { useProjectContext } from "../project/ProjectLayout";
import { provisioningApi } from "./provisioning-api";
import { formatUsd } from "../../lib/format";

const WINDOWS = [7, 30] as const;

/**
 * Chi phí THỰC của project (Plan #38, §5.5 Cost Management): số đo được từ bộ tính trong cluster,
 * chia theo environment — khác con số ƯỚC TÍNH ở bước xem trước. Chưa bật Cost ⇒ nói cách bật
 * thay vì báo lỗi.
 */
export function CostPanel() {
  const { project } = useProjectContext();
  const [days, setDays] = useState<(typeof WINDOWS)[number]>(7);
  const cost = useQuery({
    queryKey: qk.cost(project.id, days),
    queryFn: () => provisioningApi.cost(project.id, days),
    retry: false,
  });
  const notEnabled =
    cost.isError &&
    problemSlugOf(cost.error) === DOMAIN_ERROR_SLUGS.costNotEnabled;

  return (
    <section aria-label="Chi phí thực tế">
      <h2 className="h2">Chi phí thực tế</h2>
      <div className="seg" role="group" aria-label="Cửa sổ chi phí">
        {WINDOWS.map((d) => (
          <button
            key={d}
            type="button"
            aria-pressed={days === d}
            onClick={() => setDays(d)}
          >
            {d} ngày
          </button>
        ))}
      </div>
      {cost.isPending && <Loading />}
      {notEnabled && (
        <Empty title="Chưa bật Cost Management">
          Bật OpenCost hay Kubecost ở trang Domain để thấy chi phí theo
          environment.
        </Empty>
      )}
      {cost.isError && !notEnabled && (
        <ErrorState error={cost.error} onRetry={() => void cost.refetch()} />
      )}
      {cost.data !== undefined && (
        <table className="dtable" aria-label="Chi phí theo environment">
          <thead>
            <tr>
              <th scope="col">Environment</th>
              <th scope="col" className="num">
                CPU
              </th>
              <th scope="col" className="num">
                RAM
              </th>
              <th scope="col" className="num">
                Lưu trữ
              </th>
              <th scope="col" className="num">
                Mạng
              </th>
              <th scope="col" className="num">
                Tổng
              </th>
            </tr>
          </thead>
          <tbody>
            {cost.data.cost.environments.map((e) => (
              <tr key={e.environmentId}>
                <td>{e.name}</td>
                <td className="num">{formatUsd(e.cpuUsd)}</td>
                <td className="num">{formatUsd(e.ramUsd)}</td>
                <td className="num">{formatUsd(e.storageUsd)}</td>
                <td className="num">{formatUsd(e.networkUsd)}</td>
                <td className="num">{formatUsd(e.totalUsd)}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <td colSpan={5}>
                Tổng {cost.data.cost.days} ngày, nguồn {cost.data.cost.provider}
              </td>
              <td className="num">
                <b>{formatUsd(cost.data.cost.totalUsd)}</b>
              </td>
            </tr>
          </tfoot>
        </table>
      )}
    </section>
  );
}
