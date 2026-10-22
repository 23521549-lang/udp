import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { JobDetailWire, ProjectRoleWire } from "@udp/shared-types/wire";
import { CircleAlert, CircleCheck } from "lucide-react";
import { useEffect, useState } from "react";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { Icon } from "../../components/Icon";
import { ErrorState, Loading } from "../../components/States";
import { useMessages } from "../../i18n";
import { messageOf } from "../../lib/errors";
import { formatDateTime } from "../../lib/format";
import { qk } from "../../lib/query-keys";
import { domainName, domainStatusLabel } from "../domain/domain-labels";
import { can } from "../project/roles";
import { provisioningApi } from "./provisioning-api";
import { provisioningMessages } from "./provisioning.messages";
import {
  jobStateLabel,
  PHASES,
  resourceStatusLabel,
  TERMINAL_STATES,
} from "./provisioning-labels";

/** Polling dự phòng khi trình duyệt không mở được SSE — dừng ở trạng thái cuối */
const FALLBACK_POLL_MS = 5_000;

/**
 * Luồng SSE CHỈ để làm mới cache (§10.14): nhận `snapshot` ⇒ `invalidateQueries`, dữ liệu
 * hiển thị luôn đến từ `GET /jobs/:jobId`. Máy chủ đóng luồng ở trạng thái cuối; đóng
 * phía này luôn để EventSource không tự nối lại một luồng đã xong.
 */
function useJobEvents(projectId: string, jobId: string, live: boolean) {
  const queryClient = useQueryClient();
  useEffect(() => {
    if (!live || typeof EventSource === "undefined") return;
    const source = new EventSource(provisioningApi.streamUrl(projectId, jobId));
    source.addEventListener("snapshot", (event) => {
      void queryClient.invalidateQueries({
        queryKey: qk.job(projectId, jobId),
      });
      void queryClient.invalidateQueries({ queryKey: qk.jobs(projectId) });
      void queryClient.invalidateQueries({ queryKey: qk.project(projectId) });
      const state = (
        JSON.parse((event as MessageEvent<string>).data) as JobDetailWire
      ).job.state;
      if (TERMINAL_STATES.includes(state)) source.close();
    });
    return () => source.close();
  }, [projectId, jobId, live, queryClient]);
}

export function JobLog({
  projectId,
  jobId,
  role,
  onTerminal,
}: {
  projectId: string;
  jobId: string;
  role: ProjectRoleWire;
  /** Gọi MỘT lần khi job tới trạng thái cuối — màn hình chủ làm mới dữ liệu job đã đổi */
  onTerminal?: () => void;
}) {
  const query = useQuery({
    queryKey: qk.job(projectId, jobId),
    queryFn: () => provisioningApi.job(projectId, jobId),
    refetchInterval: (q) => {
      const state = q.state.data?.job.state;
      return state !== undefined && TERMINAL_STATES.includes(state)
        ? false
        : FALLBACK_POLL_MS;
    },
  });
  const live =
    query.data !== undefined && !TERMINAL_STATES.includes(query.data.job.state);
  useJobEvents(projectId, jobId, live);
  const finished = query.data !== undefined && !live;
  useEffect(() => {
    if (finished) onTerminal?.();
  }, [finished, onTerminal]);

  if (query.isPending) return <Loading />;
  if (query.isError) {
    return (
      <ErrorState error={query.error} onRetry={() => void query.refetch()} />
    );
  }
  return (
    <JobView
      projectId={projectId}
      detail={query.data}
      canCancel={can(role, "OWNER")}
    />
  );
}

function JobView({
  projectId,
  detail,
  canCancel,
}: {
  projectId: string;
  detail: JobDetailWire;
  canCancel: boolean;
}) {
  const queryClient = useQueryClient();
  const { job } = detail;
  const m = useMessages(provisioningMessages).job;
  const [confirming, setConfirming] = useState(false);
  const cancel = useMutation({
    mutationFn: () => provisioningApi.cancel(projectId, job.id),
    onSuccess: async () => {
      setConfirming(false);
      await queryClient.invalidateQueries({
        queryKey: qk.job(projectId, job.id),
      });
    },
  });
  const reached = PHASES.indexOf(job.state as (typeof PHASES)[number]);

  return (
    <section aria-label={m.progress}>
      <dl className="props">
        <dt>{m.status}</dt>
        {/* Đổi pha được đọc lên: job chạy nhiều phút, người dùng không ngồi nhìn màn hình */}
        <dd aria-live="polite">
          <span className="chip soft">{jobStateLabel(job.state)}</span>
        </dd>
        <dt>{m.started}</dt>
        <dd>{formatDateTime(job.createdAt)}</dd>
        <dt>{m.updated}</dt>
        <dd>{formatDateTime(job.updatedAt)}</dd>
      </dl>

      <ol className="phase-list" aria-label={m.phases}>
        {PHASES.map((phase, i) => (
          <li
            key={phase}
            className="chip"
            {...(phase === job.state
              ? { "aria-current": "step" as const }
              : {})}
          >
            {job.state === "DONE" || (reached >= 0 && i < reached) ? (
              <>
                <Icon of={CircleCheck} />
                <span className="visually-hidden">{m.phaseDone}</span>
              </>
            ) : null}
            {jobStateLabel(phase)}
          </li>
        ))}
      </ol>

      {job.lastError !== null && (
        <div className="alert" role="alert">
          <Icon of={CircleAlert} />
          <div>
            {job.lastError.message}
            {job.lastError.orphans.length > 0 && (
              <div className="q">
                {m.orphans(
                  job.lastError.orphans.length,
                  job.lastError.orphans.join(", "),
                )}
              </div>
            )}
          </div>
        </div>
      )}

      {detail.resources.length > 0 && (
        <div className="table-wrap">
          <table className="dtable" aria-label={m.resources}>
            <thead>
              <tr>
                <th scope="col">{m.name}</th>
                <th scope="col">{m.kind}</th>
                <th scope="col">{m.status}</th>
              </tr>
            </thead>
            <tbody>
              {detail.resources.map((r) => (
                <tr key={`${r.step}:${r.name}`}>
                  <th scope="row" className="mono">
                    {r.name}
                  </th>
                  <td className="mono">{r.kind}</td>
                  <td>{resourceStatusLabel(r.status)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {detail.domains.length > 0 && (
        <ul className="plan-list" aria-label={m.domains}>
          {detail.domains.map((d) => (
            <li key={d.domainType}>
              {domainName(d.domainType)}: {domainStatusLabel(d.status)}
              {d.message !== null && ` (${d.message})`}
            </li>
          ))}
        </ul>
      )}

      {canCancel && job.cancellable && (
        <div className="form-actions" style={{ justifyContent: "flex-start" }}>
          <button
            type="button"
            className="btn"
            onClick={() => setConfirming(true)}
          >
            {m.cancel}
          </button>
        </div>
      )}
      {confirming && (
        <ConfirmDialog
          title={m.cancelTitle}
          description={m.cancelDescription}
          confirmLabel={m.cancelConfirm}
          danger
          busy={cancel.isPending}
          error={cancel.isError ? messageOf(cancel.error) : undefined}
          onConfirm={() => cancel.mutate()}
          onClose={() => setConfirming(false)}
        />
      )}
    </section>
  );
}
