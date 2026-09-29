import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import type { DeploymentWire } from "@udp/shared-types/wire";
import { CircleAlert, CircleCheck, CircleX } from "lucide-react";
import { useState } from "react";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { Icon } from "../../components/Icon";
import { Empty, ErrorState, Loading } from "../../components/States";
import { messageOf } from "../../lib/errors";
import { formatDateTime } from "../../lib/format";
import { qk } from "../../lib/query-keys";
import { ProjectBar } from "../project/ProjectBar";
import { useProjectContext } from "../project/ProjectLayout";
import { can } from "../project/roles";
import { deploymentApi } from "./deployment-api";
import { DoraCards } from "./DoraCards";
import { PageHead } from "../../components/PageHead";

const RANGES = [7, 30, 90] as const;

const STATUS: Record<
  DeploymentWire["status"],
  { label: string; icon: typeof CircleCheck; tone: string }
> = {
  DEPLOY_PENDING: {
    label: "Chờ duyệt",
    icon: CircleAlert,
    tone: "var(--amber)",
  },
  DEPLOY_START: {
    label: "Đang deploy",
    icon: CircleAlert,
    tone: "var(--accent)",
  },
  DEPLOY_SUCCESS: {
    label: "Thành công",
    icon: CircleCheck,
    tone: "var(--green)",
  },
  DEPLOY_FAILURE: { label: "Thất bại", icon: CircleX, tone: "var(--red)" },
  FLAG_CHANGE: { label: "Đổi flag", icon: CircleCheck, tone: "var(--ink-3)" },
  ROLLBACK: { label: "Rollback", icon: CircleX, tone: "var(--red)" },
};

const TRIGGER: Record<DeploymentWire["triggeredBy"], string> = {
  WEBHOOK: "CI/CD",
  MANUAL: "thủ công",
  ROLLBACK: "rollback",
  AUTO: "tự động",
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
      <ProjectBar title="Deploy" />
      <div className="scroll">
        <PageHead
          title="Deploy"
          lead={<>Lịch sử triển khai và bốn chỉ số DORA ở {env.name}.</>}
          actions={
            <div className="seg" role="group" aria-label="Khoảng thời gian">
              {RANGES.map((d) => (
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

          <h2 className="h2">Deployment gần đây</h2>
          {list.isPending ? (
            <Loading />
          ) : list.isError ? (
            <ErrorState
              error={list.error}
              onRetry={() => void list.refetch()}
            />
          ) : list.data.deployments.length === 0 ? (
            <Empty title={`Chưa có deployment nào ở ${env.name}`}>
              Deploy từ webhook CI/CD và rollback của rollout theo flag sẽ hiện
              ở đây.
            </Empty>
          ) : (
            <div className="lst" role="list" aria-label="Deployment">
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
          {s.label}
        </span>
        <span className="mono">
          {d.imageTag ?? d.workloadName ?? d.deploymentId.slice(0, 8)}
        </span>
        {d.commitSha !== null && (
          <span className="mono c3">{d.commitSha.slice(0, 7)}</span>
        )}
        <span className="c3">{TRIGGER[d.triggeredBy]}</span>
        {d.rolloutSessionId !== null && (
          <Link
            to="/app/projects/$projectId/rollouts/$rolloutId"
            params={{ projectId: project.id, rolloutId: d.rolloutSessionId }}
            className="c3"
          >
            xem rollout
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
          Nhật ký
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
  const { project } = useProjectContext();
  const logs = useQuery({
    queryKey: qk.deploymentLogs(project.id, deploymentId),
    queryFn: () => deploymentApi.logs(project.id, deploymentId),
  });
  if (logs.isPending) return <Loading />;
  if (logs.isError) return <ErrorState error={logs.error} />;
  return (
    <ol
      className="lst"
      aria-label={`Nhật ký deploy ${deploymentId.slice(0, 8)}`}
    >
      {logs.data.events.map((e) => (
        <li key={e.id} className="it">
          <span className="stt">{STATUS[e.eventType].label}</span>
          <span className="c3">{TRIGGER[e.triggeredBy]}</span>
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
        Duyệt deploy
      </button>
      {confirming && (
        <ConfirmDialog
          title={`Deploy ${d.imageTag ?? d.deploymentId.slice(0, 8)} vào ${env.name}?`}
          description="UDP áp image vào workload rồi theo dõi; không lên kịp hạn thì tự hoàn tác về bản cũ. Flag vẫn tắt: deploy không phải release."
          confirmLabel="Duyệt deploy"
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
