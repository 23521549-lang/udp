import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { JobDetailWire, ProjectRoleWire } from "@udp/shared-types/wire";
import { CircleAlert, CircleCheck } from "lucide-react";
import { useEffect, useState } from "react";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { Icon } from "../../components/Icon";
import { ErrorState, Loading } from "../../components/States";
import { messageOf } from "../../lib/errors";
import { formatDateTime } from "../../lib/format";
import { qk } from "../../lib/query-keys";
import { STATUS_LABEL } from "../domain/domain-labels";
import { can } from "../project/roles";
import { provisioningApi } from "./provisioning-api";
import {
  JOB_STATE_LABEL,
  PHASES,
  RESOURCE_STATUS_LABEL,
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
    <section aria-label="Tiến độ triển khai">
      <dl className="props">
        <dt>Trạng thái</dt>
        <dd>
          <span className="chip soft">{JOB_STATE_LABEL[job.state]}</span>
        </dd>
        <dt>Bắt đầu</dt>
        <dd>{formatDateTime(job.createdAt)}</dd>
        <dt>Cập nhật</dt>
        <dd>{formatDateTime(job.updatedAt)}</dd>
      </dl>

      <ol className="phase-list" aria-label="Các pha">
        {PHASES.map((phase, i) => (
          <li
            key={phase}
            className="chip"
            {...(phase === job.state
              ? { "aria-current": "step" as const }
              : {})}
          >
            {job.state === "DONE" || (reached >= 0 && i < reached) ? (
              <Icon of={CircleCheck} />
            ) : null}
            {JOB_STATE_LABEL[phase]}
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
                Còn {job.lastError.orphans.length} tài nguyên chưa dọn được:{" "}
                {job.lastError.orphans.join(", ")}
              </div>
            )}
          </div>
        </div>
      )}

      {detail.resources.length > 0 && (
        <div className="table-wrap">
          <table className="matrix" aria-label="Tài nguyên cloud">
            <thead>
              <tr>
                <th scope="col">Tên</th>
                <th scope="col">Loại</th>
                <th scope="col">Trạng thái</th>
              </tr>
            </thead>
            <tbody>
              {detail.resources.map((r) => (
                <tr key={`${r.step}:${r.name}`}>
                  <th scope="row" className="mono">
                    {r.name}
                  </th>
                  <td className="mono">{r.kind}</td>
                  <td>{RESOURCE_STATUS_LABEL[r.status]}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {detail.domains.length > 0 && (
        <ul className="plan-list" aria-label="Domain">
          {detail.domains.map((d) => (
            <li key={d.domainType}>
              {d.domainType}: {STATUS_LABEL[d.status]}
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
            Hủy triển khai
          </button>
        </div>
      )}
      {confirming && (
        <ConfirmDialog
          title="Hủy lượt triển khai này?"
          description="UDP dừng ở bước kế tiếp rồi xoá mọi tài nguyên đã dựng trên cloud của bạn."
          confirmLabel="Hủy và dọn"
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
