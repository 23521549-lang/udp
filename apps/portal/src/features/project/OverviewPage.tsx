import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import {
  ChartNoAxesColumnIncreasing,
  Flag,
  LayoutDashboard,
  Lock,
  Rocket,
  Server,
  Users,
} from "lucide-react";
import { Icon } from "../../components/Icon";
import { ErrorState, Loading } from "../../components/States";
import {
  browserTimeZone,
  formatDateTime,
  formatPercent,
} from "../../lib/format";
import { qk } from "../../lib/query-keys";
import { deploymentApi } from "../deployment/deployment-api";
import { useFlagCounts } from "../flag/flag-counts";
import { rolloutApi } from "../rollout/rollout-api";
import { RolloutStatusLabel } from "../rollout/rollout-status";
import { ProjectStatus } from "./ProjectsPage";
import { ProjectBar } from "./ProjectBar";
import { useProjectContext } from "./ProjectLayout";
import { projectApi } from "./project-api";
import { ROLE_LABEL } from "./roles";

/**
 * Tổng quan (§10.6): trạng thái project, ba chỉ số nhanh (flag đang bật ở env đang chọn, rollout
 * đang chạy, thành viên), [Plan #45] thẻ Cluster (địa chỉ từ phong bì chi tiết project) và thẻ
 * Deploy gần nhất của env đang chọn (`staleTime` 30 giây, làm mới khi quay lại tab — §10.6),
 * environment, và rollout gần nhất.
 */
export function OverviewPage() {
  const { project, envs, env, cluster } = useProjectContext();
  const tz = browserTimeZone();

  // [Plan #41] Hai con số bằng `limit=1` — không tải danh sách flag chỉ để đếm
  const flagCounts = useFlagCounts(project.id, env.id);
  const rollouts = useQuery({
    queryKey: qk.rollouts(project.id, env.id),
    queryFn: () => rolloutApi.list(project.id, env.id),
  });
  const latest = useQuery({
    queryKey: qk.deploymentLatest(project.id, env.id),
    queryFn: () => deploymentApi.latest(project.id, env.id),
    staleTime: 30_000,
    refetchOnWindowFocus: true,
  });
  const members = useQuery({
    queryKey: qk.members(project.id),
    queryFn: () => projectApi.members(project.id),
  });

  const running =
    rollouts.data?.rollouts.filter(
      (r) => r.status === "IN_PROGRESS" || r.status === "PAUSED",
    ).length ?? 0;

  return (
    <>
      <ProjectBar title="Tổng quan" />
      <div className="scroll">
        <div className="mhead">
          <span className="tile xl">
            <Icon of={LayoutDashboard} size={21} />
          </span>
          <div>
            <h1>{project.name}</h1>
            <p>
              <ProjectStatus
                status={project.status}
                expiresAt={project.expiresAt}
              />{" "}
              · Vai của bạn: {ROLE_LABEL[project.myRole]}
            </p>
          </div>
        </div>
        <div className="page">
          <div className="kpis">
            <Kpi
              icon={Flag}
              label={`Flag đang bật ở ${env.name}`}
              value={
                flagCounts.enabled === undefined
                  ? "…"
                  : String(flagCounts.enabled)
              }
              sub={
                flagCounts.total === undefined
                  ? ""
                  : `trên ${String(flagCounts.total)} flag`
              }
            />
            <Kpi
              icon={ChartNoAxesColumnIncreasing}
              label={`Rollout đang chạy ở ${env.name}`}
              value={rollouts.isPending ? "…" : String(running)}
              sub=""
            />
            <Kpi
              icon={Users}
              label="Thành viên"
              value={
                members.isPending
                  ? "…"
                  : String(members.data?.members.length ?? 0)
              }
              sub=""
            />
          </div>

          <div className="kpis">
            <div className="kpi" aria-label="Cluster">
              <div className="l">
                <span className="tile">
                  <Icon of={Server} />
                </span>
                Cluster
              </div>
              {cluster === null ? (
                <div className="c3">
                  Chưa có cluster: project chưa triển khai hạ tầng.
                </div>
              ) : (
                <>
                  <div className="mono">{cluster.clusterId}</div>
                  <div className="c3 mono">{cluster.apiEndpoint}</div>
                  <div className="c3">
                    {cluster.provider} · {cluster.region}
                  </div>
                </>
              )}
            </div>
            <div className="kpi" aria-label="Deploy gần nhất">
              <div className="l">
                <span className="tile">
                  <Icon of={Rocket} />
                </span>
                Deploy gần nhất ở {env.name}
              </div>
              {latest.isPending ? (
                <div className="c3">…</div>
              ) : latest.isError ? (
                <ErrorState error={latest.error} />
              ) : latest.data.deployment === null ? (
                <div className="c3">Chưa có lần deploy nào.</div>
              ) : (
                <>
                  <div className="mono">
                    {latest.data.deployment.imageTag ??
                      latest.data.deployment.deploymentId.slice(0, 8)}
                  </div>
                  <div className="c3">
                    {latest.data.deployment.commitSha === null
                      ? ""
                      : `${latest.data.deployment.commitSha.slice(0, 7)} · `}
                    {formatDateTime(latest.data.deployment.lastEventAt)}
                  </div>
                  <Link
                    to="/app/projects/$projectId/deployments"
                    params={{ projectId: project.id }}
                    search={{ env: env.id }}
                    className="c3"
                  >
                    xem lịch sử deploy
                  </Link>
                </>
              )}
            </div>
          </div>

          <h2 className="h2">Environment</h2>
          <div className="lst">
            {[...envs]
              .sort((a, b) => a.rank - b.rank)
              .map((e) => (
                <div key={e.id} className="it">
                  <b style={{ fontWeight: 500 }}>{e.name}</b>
                  {e.isProduction && <Icon of={Lock} size={12} />}
                  <span className="mono c3">{e.k8sNamespace}</span>
                  <span className="c3" style={{ marginLeft: "auto" }}>
                    {e.autoDeploy ? "Tự deploy" : "Deploy thủ công"}
                  </span>
                </div>
              ))}
          </div>

          <h2 className="h2">Rollout gần đây ở {env.name}</h2>
          {rollouts.isPending ? (
            <Loading />
          ) : rollouts.isError ? (
            <ErrorState error={rollouts.error} />
          ) : rollouts.data.rollouts.length === 0 ? (
            <p className="c3">Chưa có rollout nào ở environment này.</p>
          ) : (
            <div className="lst">
              {rollouts.data.rollouts.slice(0, 5).map((r) => (
                <Link
                  key={r.id}
                  to="/app/projects/$projectId/rollouts/$rolloutId"
                  params={{ projectId: project.id, rolloutId: r.id }}
                  search={{ env: env.id }}
                >
                  <span className="mono">
                    {r.flagKey ?? r.workloadName ?? r.id.slice(0, 8)}
                  </span>
                  <RolloutStatusLabel status={r.status} />
                  <span className="num c3">
                    {formatPercent(r.currentTrafficPercentage)}
                  </span>
                  <span className="c3" style={{ marginLeft: "auto" }}>
                    {formatDateTime(r.updatedAt)}
                  </span>
                </Link>
              ))}
            </div>
          )}
        </div>
      </div>
    </>
  );
}

function Kpi({
  icon,
  label,
  value,
  sub,
}: {
  icon: typeof Flag;
  label: string;
  value: string;
  sub: string;
}) {
  return (
    <div className="kpi">
      <div className="l">
        <span className="tile">
          <Icon of={icon} />
        </span>
        {label}
      </div>
      <div className="v num">{value}</div>
      {sub !== "" && <div className="c3">{sub}</div>}
    </div>
  );
}
