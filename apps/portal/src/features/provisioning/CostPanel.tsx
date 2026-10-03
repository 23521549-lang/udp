import { useQuery } from "@tanstack/react-query";
import { DOMAIN_ERROR_SLUGS } from "@udp/shared-types/domain-api";
import { useState } from "react";
import { Empty, ErrorState, Loading } from "../../components/States";
import { useMessages } from "../../i18n";
import { problemSlugOf } from "../../lib/errors";
import { qk } from "../../lib/query-keys";
import { useProjectContext } from "../project/ProjectLayout";
import { provisioningApi } from "./provisioning-api";
import { provisioningMessages } from "./provisioning.messages";
import { formatUsd } from "../../lib/format";

const WINDOWS = [7, 30] as const;

/**
 * Chi phí THỰC của project (Plan #38, §5.5 Cost Management): số đo được từ bộ tính trong cluster,
 * chia theo environment — khác con số ƯỚC TÍNH ở bước xem trước. Chưa bật Cost ⇒ nói cách bật
 * thay vì báo lỗi.
 */
export function CostPanel() {
  const { project } = useProjectContext();
  const m = useMessages(provisioningMessages).cost;
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
    <section aria-label={m.title}>
      <h2 className="h2">{m.title}</h2>
      <div className="seg" role="group" aria-label={m.window}>
        {WINDOWS.map((d) => (
          <button
            key={d}
            type="button"
            aria-pressed={days === d}
            onClick={() => setDays(d)}
          >
            {m.days(d)}
          </button>
        ))}
      </div>
      {cost.isPending && <Loading />}
      {notEnabled && <Empty title={m.notEnabled}>{m.notEnabledHint}</Empty>}
      {cost.isError && !notEnabled && (
        <ErrorState error={cost.error} onRetry={() => void cost.refetch()} />
      )}
      {cost.data !== undefined && (
        <table className="dtable" aria-label={m.table}>
          <thead>
            <tr>
              <th scope="col">{m.environment}</th>
              <th scope="col" className="num">
                {m.cpu}
              </th>
              <th scope="col" className="num">
                {m.ram}
              </th>
              <th scope="col" className="num">
                {m.storage}
              </th>
              <th scope="col" className="num">
                {m.network}
              </th>
              <th scope="col" className="num">
                {m.total}
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
                {m.footer(cost.data.cost.days, cost.data.cost.provider)}
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
