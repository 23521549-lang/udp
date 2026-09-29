import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  ProjectRoleWire,
  ProvisioningJobWire,
  ProvisionPreviewWire,
} from "@udp/shared-types/wire";
import { CircleAlert, Rocket } from "lucide-react";
import { useState } from "react";
import { Icon } from "../../components/Icon";
import { ErrorState, Loading } from "../../components/States";
import { useMessages } from "../../i18n";
import { messageOf } from "../../lib/errors";
import { qk } from "../../lib/query-keys";
import { can } from "../project/roles";
import { provisioningApi } from "./provisioning-api";
import { formatUsd } from "../../lib/format";
import { blockerLabel, costItemLabel } from "./provisioning-labels";
import { provisioningMessages } from "./provisioning.messages";

/**
 * Bước xem trước (§10.5 bước 4, §4.4 lớp 2): chi phí theo từng mục (control plane, NAT,
 * load balancer luôn có), thứ tự dựng tài nguyên, thứ tự cài domain, thời gian ước tính.
 * Project có production thì phải tích xác nhận ĐÚNG con số đang thấy; máy chủ so lại con
 * số đó và trả 428 nếu giá đã đổi.
 */
export function PreviewPanel({
  projectId,
  role,
  onStarted,
}: {
  projectId: string;
  role: ProjectRoleWire;
  onStarted: (job: ProvisioningJobWire) => void;
}) {
  const query = useQuery({
    queryKey: qk.provisionPreview(projectId),
    queryFn: () => provisioningApi.preview(projectId),
  });
  if (query.isPending) return <Loading />;
  if (query.isError) {
    return (
      <ErrorState error={query.error} onRetry={() => void query.refetch()} />
    );
  }
  return (
    <Preview
      projectId={projectId}
      canStart={can(role, "OWNER")}
      preview={query.data.preview}
      onStarted={onStarted}
    />
  );
}

function Preview({
  projectId,
  canStart,
  preview,
  onStarted,
}: {
  projectId: string;
  canStart: boolean;
  preview: ProvisionPreviewWire;
  onStarted: (job: ProvisioningJobWire) => void;
}) {
  const queryClient = useQueryClient();
  const m = useMessages(provisioningMessages).preview;
  const [confirmed, setConfirmed] = useState(false);
  const start = useMutation({
    mutationFn: () =>
      provisioningApi.provision(
        projectId,
        preview.requiresConfirmation
          ? { confirmedMonthlyUsd: preview.cost.monthlyUsd }
          : {},
        // §9: sinh lúc BẤM — bấm lại do mạng chậm trả đúng job cũ
        crypto.randomUUID(),
      ),
    onSuccess: async ({ job }) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: qk.project(projectId) }),
        queryClient.invalidateQueries({ queryKey: qk.jobs(projectId) }),
        queryClient.invalidateQueries({
          queryKey: qk.provisionPreview(projectId),
        }),
      ]);
      onStarted(job);
    },
  });
  const blocked = preview.blockers.length > 0;
  const ready = !blocked && (!preview.requiresConfirmation || confirmed);

  return (
    <section aria-label={m.label}>
      <dl className="props">
        <dt>{m.cloud}</dt>
        <dd>
          {preview.provider}
          <span className="chip soft">{preview.region}</span>
        </dd>
        <dt>{m.cluster}</dt>
        <dd>{m.nodes(preview.cluster.nodeCount, preview.cluster.nodeSize)}</dd>
        <dt>{m.duration}</dt>
        <dd>
          {m.minutes(
            preview.estimatedMinutes.min,
            preview.estimatedMinutes.max,
          )}
        </dd>
      </dl>

      <div className="table-wrap">
        <table className="dtable" aria-label={m.cost}>
          <thead>
            <tr>
              <th scope="col">{m.item}</th>
              <th scope="col" className="num">
                {m.perMonth}
              </th>
            </tr>
          </thead>
          <tbody>
            {preview.cost.breakdown.map((line) => (
              <tr key={line.item}>
                <th scope="row">{costItemLabel(line.item)}</th>
                <td className="num">{formatUsd(line.monthlyUsd)}</td>
              </tr>
            ))}
            <tr>
              <th scope="row">{m.total}</th>
              <td className="num">
                <b>{formatUsd(preview.cost.monthlyUsd)}</b>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <p className="c3">
        {m.pricing(preview.cost.isEstimate, preview.cost.pricingAsOf)}
      </p>

      <h2 className="h2">{m.buildOrder}</h2>
      <ol className="plan-list" aria-label={m.resourceOrder}>
        {[...preview.steps.network, ...preview.steps.cluster].map((name) => (
          <li key={name} className="mono">
            {name}
          </li>
        ))}
      </ol>
      {preview.deployOrder.length > 0 && (
        <ol className="plan-list" aria-label={m.domainOrder}>
          {preview.deployOrder.map((tier, i) => (
            <li key={tier.join(",")}>
              {m.stage(i + 1, <span className="mono">{tier.join(", ")}</span>)}
            </li>
          ))}
        </ol>
      )}

      {blocked && (
        <div className="alert amber" role="status" aria-label={m.blocked}>
          <Icon of={CircleAlert} />
          <ul>
            {preview.blockers.map((b) => (
              <li key={b}>{blockerLabel(b)}</li>
            ))}
          </ul>
        </div>
      )}

      {canStart && !blocked && preview.requiresConfirmation && (
        <label className="confirm-line">
          <input
            type="checkbox"
            checked={confirmed}
            onChange={(e) => setConfirmed(e.target.checked)}
          />
          {m.confirmCost(formatUsd(preview.cost.monthlyUsd))}
        </label>
      )}
      {start.isError && (
        <p role="alert" className="field-error">
          {messageOf(start.error)}
        </p>
      )}
      {canStart && (
        <div className="form-actions" style={{ justifyContent: "flex-start" }}>
          <button
            type="button"
            className="btn pri"
            disabled={!ready || start.isPending}
            onClick={() => start.mutate()}
          >
            <Icon of={Rocket} />
            {start.isPending ? m.sending : m.start}
          </button>
        </div>
      )}
    </section>
  );
}
