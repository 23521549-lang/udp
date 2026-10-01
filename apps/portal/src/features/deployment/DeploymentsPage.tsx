import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import type { DeploymentWire } from "@udp/shared-types/wire";
import { CircleAlert, CircleCheck, CircleX } from "lucide-react";
import { useState } from "react";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { Icon } from "../../components/Icon";
import { InfoTip } from "../../components/InfoTip";
import { Empty, ErrorState, Loading } from "../../components/States";
import { useMessages } from "../../i18n";
import { messageOf } from "../../lib/errors";
import { formatDateTime } from "../../lib/format";
import { qk } from "../../lib/query-keys";
import { ProjectBar } from "../project/ProjectBar";
import { useProjectContext } from "../project/ProjectLayout";
import { can } from "../project/roles";
import { deploymentApi } from "./deployment-api";
import { deploymentMessages } from "./deployment.messages";
import { DoraCards } from "./DoraCards";
import { PageHead } from "../../components/PageHead";

const RANGES = [7, 30, 90] as const;

/** Icon và màu của mỗi trạng thái; chữ ở `deploymentMessages.status` */
const STATUS: Record<
  DeploymentWire["status"],
  { icon: typeof CircleCheck; tone: string }
> = {
  DEPLOY_PENDING: { icon: CircleAlert, tone: "var(--amber)" },
  DEPLOY_START: { icon: CircleAlert, tone: "var(--accent)" },
  DEPLOY_SUCCESS: { icon: CircleCheck, tone: "var(--green)" },
  DEPLOY_FAILURE: { icon: CircleX, tone: "var(--red)" },
  FLAG_CHANGE: { icon: CircleCheck, tone: "var(--ink-3)" },
  ROLLBACK: { icon: CircleX, tone: "var(--red)" },
};

/**
 * Deploy + DORA (§10.14, §2.2). Hai query khoá theo `envId`; DORA thêm `days` vào key —
 * không có thì đổi khoảng mà con số không đổi (tiêu chí "Không đạt" của sổ nợ cũ).
 *
 * Event Store có hai nguồn ghi: webhook CI/CD (§8.3) và Service 3 (ROLLBACK của rollout theo
 * flag). Chưa có sự kiện deploy thì bốn chỉ số trống — trang nói thật điều đó thay vì hiện số 0.
 * Deploy chờ duyệt (`autoDeploy = false`) có nút duyệt cho MAINTAINER.
 */
export function DeploymentsPage() {
  const m = useMessages(deploymentMessages);
  const { project, env } = useProjectContext();
  const [days, setDays] = useState<(typeof RANGES)[number]>(30);
  const dora = useQuery({
    queryKey: qk.dora(project.id, env.id, days),
    queryFn: () => deploymentApi.dora(project.id, env.id, days),
  });
  const list = useQuery({
    queryKey: qk.deployments(project.id, env.id),
    queryFn: () => deploymentApi.list(project.id, env.id),
    staleTime: 30_000,
    refetchOnWindowFocus: true,
  });

  return (
    <>
      <ProjectBar title={m.title} />
      <div className="scroll">
        <PageHead
          title={m.title}
          lead={
            <>
              {m.lead(env.name)}
              <InfoTip term="dora" />
            </>
          }
          actions={
            <div className="seg" role="group" aria-label={m.range}>
              {RANGES.map((d) => (
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
          }
        />
        <div className="page">
          {dora.isPending ? (
            <Loading />
          ) : dora.isError ? (
            <ErrorState
              error={dora.error}
              onRetry={() => void dora.refetch()}
            />
          ) : (
            <DoraCards dora={dora.data.dora} />
          )}

          <h2 className="h2">{m.recent}</h2>
          {list.isPending ? (
            <Loading />
          ) : list.isError ? (
            <ErrorState
              error={list.error}
              onRetry={() => void list.refetch()}
            />
          ) : list.data.deployments.length === 0 ? (
            <Empty title={m.empty(env.name)}>{m.emptyHint}</Empty>
          ) : (
            <div className="lst" role="list" aria-label={m.list}>
              {list.data.deployments.map((d) => (
                <DeploymentRow key={d.deploymentId} deployment={d} />
              ))}
            </div>
          )}
        </div>
      </div>
    </>
  );
}

function DeploymentRow({ deployment: d }: { deployment: DeploymentWire }) {
  const m = useMessages(deploymentMessages);
  const { project } = useProjectContext();
  const [open, setOpen] = useState(false);
  const s = STATUS[d.status];
  const approvable =
    d.status === "DEPLOY_PENDING" && can(project.myRole, "MAINTAINER");
  return (
    <>
      <div className="it" role="listitem">
        <span className="stt">
          <Icon of={s.icon} style={{ color: s.tone }} />
          {m.status[d.status]}
        </span>
        {d.status === "DEPLOY_PENDING" && <InfoTip term="approval" />}
        <span className="mono" translate="no">
          {d.imageTag ?? d.workloadName ?? d.deploymentId.slice(0, 8)}
        </span>
        {d.commitSha !== null && (
          <span className="mono c3">{d.commitSha.slice(0, 7)}</span>
        )}
        <span className="c3">{m.trigger[d.triggeredBy]}</span>
        {d.rebase && (
          <span className="stt">
            {m.rebase}
            <InfoTip term="rebase" />
          </span>
        )}
        {d.rolloutSessionId !== null && (
          <Link
            to="/app/projects/$projectId/rollouts/$rolloutId"
            params={{ projectId: project.id, rolloutId: d.rolloutSessionId }}
            className="c3"
          >
            {m.viewRollout}
          </Link>
        )}
        <span className="c3" style={{ marginLeft: "auto" }}>
          {formatDateTime(d.lastEventAt)}
        </span>
        {approvable && <ApproveButton deployment={d} />}
        <button
          type="button"
          className="btn"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
        >
          {m.log}
        </button>
      </div>
      {open && <DeploymentLog deploymentId={d.deploymentId} />}
    </>
  );
}

/**
 * [Plan #45] Mọi sự kiện của một lần deploy (§9 `GET …/deployments/:deploymentId/logs`) — `detail`
 * là metadata máy chủ đã che bí mật: lý do lỗi, image khôi phục, repo, ref.
 */
function DeploymentLog({ deploymentId }: { deploymentId: string }) {
  const m = useMessages(deploymentMessages);
  const { project } = useProjectContext();
  const logs = useQuery({
    queryKey: qk.deploymentLogs(project.id, deploymentId),
    queryFn: () => deploymentApi.logs(project.id, deploymentId),
  });
  if (logs.isPending) return <Loading />;
  if (logs.isError) return <ErrorState error={logs.error} />;
  return (
    <ol className="lst" aria-label={m.logLabel(deploymentId.slice(0, 8))}>
      {logs.data.events.map((e) => (
        <li key={e.id} className="it">
          <span className="stt">{m.status[e.eventType]}</span>
          <span className="c3">{m.trigger[e.triggeredBy]}</span>
          {e.pipelineId !== null && (
            <span className="mono c3">{e.pipelineId}</span>
          )}
          {e.detail !== null && (
            <span className="mono c3">
              {Object.entries(e.detail)
                .map(([k, v]) => `${k}: ${String(v)}`)
                .join(" · ")}
            </span>
          )}
          <span className="c3" style={{ marginLeft: "auto" }}>
            {formatDateTime(e.occurredAt)}
          </span>
        </li>
      ))}
    </ol>
  );
}

/** Duyệt một deploy chờ (§8.3): máy chủ ghi `DEPLOY_START` rồi áp image ở hàng đợi deploy */
function ApproveButton({ deployment: d }: { deployment: DeploymentWire }) {
  const m = useMessages(deploymentMessages);
  const { project, env } = useProjectContext();
  const queryClient = useQueryClient();
  const [confirming, setConfirming] = useState(false);
  const approve = useMutation({
    mutationFn: () => deploymentApi.approve(project.id, d.deploymentId),
    onSuccess: async () => {
      setConfirming(false);
      await queryClient.invalidateQueries({
        queryKey: qk.deployments(project.id, env.id),
      });
    },
  });
  return (
    <>
      <button type="button" className="btn" onClick={() => setConfirming(true)}>
        {m.approve}
      </button>
      {confirming && (
        <ConfirmDialog
          title={m.approveTitle(
            d.imageTag ?? d.deploymentId.slice(0, 8),
            env.name,
          )}
          description={m.approveDescription}
          confirmLabel={m.approve}

          busy={approve.isPending}
          error={approve.isError ? messageOf(approve.error) : undefined}
          onConfirm={() => approve.mutate()}
          onClose={() => {
            setConfirming(false);
            approve.reset();
          }}
        />
      )}
    </>
  );
}
