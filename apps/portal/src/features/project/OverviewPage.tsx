import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import type { ArchitectureWire } from "@udp/shared-types/wire";
import { Lock, Rocket, Server } from "lucide-react";
import { Icon } from "../../components/Icon";
import { PageHead } from "../../components/PageHead";
import { ErrorState, Loading } from "../../components/States";
import { formatDateTime, formatPercent } from "../../lib/format";
import { qk } from "../../lib/query-keys";
import { architectureApi } from "../architecture/architecture-api";
import { namespaceTools } from "../architecture/architecture-model";
import { DomainHealthGrid } from "../architecture/DomainHealthGrid";
import { RepoReadinessCard } from "../code/RepoReadinessCard";
import { deploymentApi } from "../deployment/deployment-api";
import { useFlagCounts } from "../flag/flag-counts";
import { rolloutApi } from "../rollout/rollout-api";
import { RolloutStatusLabel } from "../rollout/rollout-status";
import { CloudCard } from "./cloud/CloudCard";
import { PROVIDER_LABEL } from "./cloud/cloud-labels";
import { ProjectBar } from "./ProjectBar";
import { useProjectContext } from "./ProjectLayout";
import { ProjectStatus } from "./ProjectStatus";
import { projectApi } from "./project-api";
import { projectMessages } from "./project.messages";
import { rolesMessages } from "./roles.messages";
import { useMessages } from "../../i18n";

/**
 * Tổng quan (§10.6, Plan #53 QĐ-7): trạng thái project và ba chỉ số nhanh ở đầu trang; thẻ Cloud (đổi
 * cloud ở ngay đây), Cluster và Deploy gần nhất; lưới sức khoẻ domain và sơ đồ thu nhỏ — cả hai từ
 * CHÍNH `GET /architecture` của trang Kiến trúc (một nguồn); environment và rollout gần đây.
 */
export function OverviewPage() {
  const roles = useMessages(rolesMessages).role;
  const m = useMessages(projectMessages).overview;
  const { project, envs, env, cluster } = useProjectContext();

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
  const arch = useQuery({
    queryKey: qk.architecture(project.id),
    queryFn: () => architectureApi.get(project.id),
  });

  const running =
    rollouts.data?.rollouts.filter(
      (r) => r.status === "IN_PROGRESS" || r.status === "PAUSED",
    ).length ?? 0;

  return (
    <>
      <ProjectBar title={m.title} />
      <div className="scroll">
        <PageHead
          title={<span translate="no">{project.name}</span>}
          lead={
            <span className="lead-line">
              <ProjectStatus
                status={project.status}
                expiresAt={project.expiresAt}
              />
              <span>{m.yourRole(roles[project.myRole])}</span>
            </span>
          }
          minis={[
            {
              value: flagCounts.enabled ?? "…",
              label: m.flagsOn(env.name),
            },
            {
              value: rollouts.isPending ? "…" : running,
              label: m.runningRollouts,
            },
            {
              value: members.data?.members.length ?? "…",
              label: m.members,
            },
          ]}
        />
        <div className="page">
          <div className="kpis">
            {arch.data === undefined ? (
              <div className="kpi" aria-label={m.cloud}>
                {arch.isError ? (
                  <ErrorState error={arch.error} />
                ) : (
                  <div className="c3">…</div>
                )}
              </div>
            ) : (
              <CloudCard
                projectId={project.id}
                role={project.myRole}
                cloud={arch.data.architecture.cloud}
              />
            )}
            <section className="kpi" aria-label={m.cluster}>
              <div className="l">
                <span className="tile">
                  <Icon of={Server} />
                </span>
                {m.cluster}
              </div>
              {cluster === null ? (
                <div className="c3">{m.noCluster}</div>
              ) : (
                <>
                  <div className="mono" translate="no">
                    {cluster.clusterId}
                  </div>
                  <div className="c3 mono ellipsis" translate="no">
                    {cluster.apiEndpoint}
                  </div>
                </>
              )}
            </section>
            <section className="kpi" aria-label={m.latestDeploy}>
              <div className="l">
                <span className="tile">
                  <Icon of={Rocket} />
                </span>
                {m.latestDeployIn(env.name)}
              </div>
              {latest.isPending ? (
                <div className="c3">…</div>
              ) : latest.isError ? (
                <ErrorState error={latest.error} />
              ) : latest.data.deployment === null ? (
                <div className="c3">{m.noDeploy}</div>
              ) : (
                <>
                  <div className="mono" translate="no">
                    {latest.data.deployment.imageTag ??
                      latest.data.deployment.deploymentId.slice(0, 8)}
                  </div>
                  <div className="c3">
                    {latest.data.deployment.commitSha === null
                      ? ""
                      : `${latest.data.deployment.commitSha.slice(0, 7)}, `}
                    {formatDateTime(latest.data.deployment.lastEventAt)}
                  </div>
                  <Link
                    to="/app/projects/$projectId/deployments"
                    params={{ projectId: project.id }}
                    search={{ env: env.id }}
                    className="c3"
                  >
                    {m.deployHistory}
                  </Link>
                </>
              )}
            </section>
            {project.creationMode === "IMPORT_EXISTING" && (
              <RepoReadinessCard />
            )}
          </div>

          <section aria-labelledby="ov-health">
            <div className="sect">
              <h2 id="ov-health">{m.health}</h2>
              <div className="r">
                <Link
                  to="/app/projects/$projectId/domains"
                  params={{ projectId: project.id }}
                  search={{ env: env.id }}
                  className="btn"
                >
                  {m.manageDomains}
                </Link>
              </div>
            </div>
            {arch.isPending ? (
              <Loading />
            ) : arch.isError ? (
              <ErrorState
                error={arch.error}
                onRetry={() => void arch.refetch()}
              />
            ) : arch.data.architecture.tools.length === 0 ? (
              <p className="c3">{m.noDomains}</p>
            ) : (
              <DomainHealthGrid
                projectId={project.id}
                tools={arch.data.architecture.tools}
                env={env.id}
              />
            )}
          </section>

          {arch.data !== undefined && (
            <section aria-labelledby="ov-map">
              <div className="sect">
                <h2 id="ov-map">{m.architecture}</h2>
              </div>
              <MiniMap projectId={project.id} arch={arch.data.architecture} />
            </section>
          )}

          <section aria-labelledby="ov-envs">
            <div className="sect">
              <h2 id="ov-envs">{m.environments}</h2>
            </div>
            <ul className="lst" aria-labelledby="ov-envs">
              {[...envs]
                .sort((a, b) => a.rank - b.rank)
                .map((e) => (
                  <li key={e.id} className="it">
                    <b className="lst-name">{e.name}</b>
                    {e.isProduction && (
                      <span title={m.production}>
                        <Icon of={Lock} size={12} />
                        <span className="visually-hidden">
                          {m.productionHidden}
                        </span>
                      </span>
                    )}
                    <span className="mono c3" translate="no">
                      {e.k8sNamespace}
                    </span>
                    <span className="c3 lst-end">
                      {e.autoDeploy ? m.autoDeploy : m.manualDeploy}
                    </span>
                  </li>
                ))}
            </ul>
          </section>

          <section aria-labelledby="ov-rollouts">
            <div className="sect">
              <h2 id="ov-rollouts">{m.recentRollouts(env.name)}</h2>
            </div>
            {rollouts.isPending ? (
              <Loading />
            ) : rollouts.isError ? (
              <ErrorState
                error={rollouts.error}
                onRetry={() => void rollouts.refetch()}
              />
            ) : rollouts.data.rollouts.length === 0 ? (
              <p className="c3">{m.noRollouts}</p>
            ) : (
              <ul className="lst" aria-labelledby="ov-rollouts">
                {rollouts.data.rollouts.slice(0, 5).map((r) => (
                  <li key={r.id}>
                    <Link
                      to="/app/projects/$projectId/rollouts/$rolloutId"
                      params={{ projectId: project.id, rolloutId: r.id }}
                      search={{ env: env.id }}
                    >
                      <span className="mono" translate="no">
                        {r.flagKey ?? r.workloadName ?? r.id.slice(0, 8)}
                      </span>
                      <RolloutStatusLabel
                        status={r.status}
                        percent={r.currentTrafficPercentage}
                      />
                      <span className="num c3">
                        {formatPercent(r.currentTrafficPercentage)}
                      </span>
                      <span className="c3 lst-end">
                        {formatDateTime(r.updatedAt)}
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      </div>
    </>
  );
}

/**
 * Sơ đồ thu nhỏ (QĐ-7): cloud ⊃ cluster ⊃ environment, mỗi hộp kèm số workload — cùng cách lồng của
 * trang Kiến trúc, gọn trong một khối bấm được để sang đó. Là MỘT link: nội dung đọc thành một câu.
 */
function MiniMap({
  projectId,
  arch,
}: {
  projectId: string;
  arch: ArchitectureWire;
}) {
  const m = useMessages(projectMessages).overview.map;
  const clusterTools = arch.tools.length - namespaceTools(arch.tools).length;
  return (
    <Link
      to="/app/projects/$projectId/architecture"
      params={{ projectId }}
      search={{}}
      className="minimap"
    >
      <span className="mm-cloud">
        <span className="mm-h">
          {arch.cloud === null
            ? m.noCloud
            : `${PROVIDER_LABEL[arch.cloud.provider]} ${arch.cloud.region}`}
        </span>
        <span className="mm-cluster">
          <span className="mm-h">
            {arch.cluster === null ? m.noCluster : m.cluster(clusterTools)}
          </span>
          <span className="mm-envs">
            {arch.environments.map((e) => (
              <span key={e.id} className="mm-env">
                <b>{e.name}</b>
                <span className="c3">{m.workloads(e.workloads.length)}</span>
              </span>
            ))}
          </span>
        </span>
      </span>
      <span className="mm-go">{m.open}</span>
    </Link>
  );
}
