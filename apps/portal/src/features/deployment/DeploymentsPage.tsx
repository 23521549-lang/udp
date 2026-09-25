import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import type { DeploymentWire, DoraWire } from "@udp/shared-types/wire";
import { CircleAlert, CircleCheck, CircleX, Rocket } from "lucide-react";
import { useState } from "react";
import { Icon } from "../../components/Icon";
import { Empty, ErrorState, Loading } from "../../components/States";
import { formatDateTime, formatNumber, formatPercent } from "../../lib/format";
import { qk } from "../../lib/query-keys";
import { ProjectBar } from "../project/ProjectBar";
import { useProjectContext } from "../project/ProjectLayout";
import { deploymentApi } from "./deployment-api";

const RANGES = [7, 30, 90] as const;

/** Thời lượng dễ đọc: "3 giờ 20 phút", "45 giây" */
export function formatDuration(seconds: number | null): string {
  if (seconds === null) return "–";
  const s = Math.round(seconds);
  if (s < 60) return `${String(s)} giây`;
  const m = Math.round(s / 60);
  if (m < 60) return `${String(m)} phút`;
  const h = Math.floor(m / 60);
  if (h < 48)
    return m % 60 === 0
      ? `${String(h)} giờ`
      : `${String(h)} giờ ${String(m % 60)} phút`;
  return `${String(Math.round(h / 24))} ngày`;
}

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
 * Hôm nay chỉ Service 3 ghi Event Store (ROLLBACK của rollout theo flag); webhook CI/CD
 * (§8.3) chưa có nên bốn chỉ số deploy trống — trang nói thật điều đó thay vì hiện số 0.
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
        <div className="mhead">
          <span className="tile xl">
            <Icon of={Rocket} size={21} />
          </span>
          <div>
            <h1>Deploy</h1>
            <p>Lịch sử triển khai và bốn chỉ số DORA ở {env.name}.</p>
          </div>
          <div className="acts">
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
          </div>
        </div>
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
              Webhook CI/CD chưa được nối; rollback của rollout theo flag sẽ
              hiện ở đây.
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

function DoraCards({ dora }: { dora: DoraWire }) {
  const noDeploys = dora.changeFailureRate.total === 0;
  return (
    <>
      <div className="stat" aria-label="Chỉ số DORA">
        <div>
          <div className="l">Tần suất deploy</div>
          <div className="v num">
            {noDeploys
              ? "–"
              : formatNumber(
                  Math.round(dora.deploymentFrequencyPerDay * 100) / 100,
                )}
            <small>/ngày</small>
          </div>
          <div className="c3">{dora.deployments} lần thành công</div>
        </div>
        <div>
          <div className="l">Lead time</div>
          <div className="v num">
            {formatDuration(dora.leadTimeSeconds.median)}
          </div>
          <div className="c3">{dora.leadTimeSeconds.samples} mẫu có commit</div>
        </div>
        <div>
          <div className="l">Tỉ lệ thay đổi lỗi</div>
          <div className="v num">
            {dora.changeFailureRate.value === null
              ? "–"
              : formatPercent(dora.changeFailureRate.value * 100)}
          </div>
          <div className="c3">
            {dora.changeFailureRate.failed}/{dora.changeFailureRate.total}{" "}
            deployment
          </div>
        </div>
        <div>
          <div className="l">Thời gian khôi phục</div>
          <div className="v num">
            {formatDuration(dora.recoveryTimeSeconds.median)}
          </div>
          <div className="c3">
            {dora.recoveryTimeSeconds.samples} lần khôi phục
          </div>
        </div>
      </div>
      <p className="c3">
        Rollback trong {dora.window.days} ngày: {dora.rollbacks.auto} tự động
        (hệ thống canary), {dora.rollbacks.manual} thủ công.
        {noDeploys &&
          " Chưa có sự kiện deploy nào từ CI/CD nên bốn chỉ số trên chưa có số."}
      </p>
    </>
  );
}

function DeploymentRow({ deployment: d }: { deployment: DeploymentWire }) {
  const { project } = useProjectContext();
  const s = STATUS[d.status];
  return (
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
    </div>
  );
}
