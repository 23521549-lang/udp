import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { DOMAIN_ERROR_SLUGS } from "@udp/shared-types/domain-api";
import type {
  ArchitectureToolWire,
  ArchitectureWire,
} from "@udp/shared-types/wire";
import {
  Activity,
  Box,
  Coins,
  Container,
  Database,
  FileCode2,
  GitBranch,
  GitCommitHorizontal,
  Globe,
  KeyRound,
  Layers,
  Network,
  Package,
  Rocket,
  ScanSearch,
  ScrollText,
  ShieldCheck,
  Users,
  Waypoints,
  type LucideIcon,
} from "lucide-react";
import { useState, type ReactNode } from "react";
import { BarChart } from "../../components/BarChart";
import { Icon } from "../../components/Icon";
import { LinkLayer } from "../../components/LinkLayer";
import { StatusLabel } from "../../components/StatusLabel";
import { useMessages } from "../../i18n";
import { problemSlugOf } from "../../lib/errors";
import { formatNumber } from "../../lib/format";
import { qk } from "../../lib/query-keys";
import { deployBars } from "../deployment/deploy-bars";
import { DEFAULT_RED_RANGE } from "../monitoring/MonitoringPage";
import { monitoringApi } from "../monitoring/monitoring-api";
import { monitoringMessages } from "../monitoring/monitoring.messages";
import { healthSummary, toolHealth, WORKLOAD_TONE } from "./architecture-model";
import { architectureMessages } from "./architecture.messages";
import {
  ENVS,
  GIT,
  redSummary,
  SYSTEM_ZONES,
  systemLinks,
  USERS,
  zoneTools,
  type SystemLink,
  type SystemZone,
} from "./system-model";
import { systemMessages } from "./system.messages";

/**
 * [Plan #57 QĐ-2..QĐ-6] Góc "Tổng quan hệ thống" của trang Kiến trúc: sơ đồ C4 container với bố cục CỐ ĐỊNH theo
 * vai trò (giao hàng trên, lưu lượng trái, environment giữa, dữ liệu phải, quan sát dưới, quản trị phải dưới), cạnh
 * vai trò có nhãn, sức khoẻ sống trên từng thẻ, bốn con số đầu góc, và bản bảng thay thế cho sơ đồ.
 */

const DOMAIN_ICON: Record<string, LucideIcon> = {
  CICD: Rocket,
  CONTAINER_REGISTRY: Container,
  ARTIFACT_REGISTRY: Package,
  GITOPS: GitBranch,
  PROGRESSIVE_DELIVERY: Layers,
  INGRESS: Globe,
  SERVICE_MESH: Network,
  DATABASE: Database,
  SECRETS: KeyRound,
  MONITORING: Activity,
  LOGGING: ScrollText,
  TRACING: Waypoints,
  POLICY: ShieldCheck,
  SECURITY: ScanSearch,
  COST: Coins,
  INFRA: FileCode2,
};

/** Cạnh đi từ dải trên xuống khung environment, hay từ khung xuống dải dưới: nối mép trên–dưới */
const VERTICAL = new Set<SystemLink["kind"]>([
  "canary",
  "metrics",
  "logs",
  "traces",
]);

/** Hai công cụ registry chồng nhau trong MỘT ô của dải giao hàng: cạnh CI → GitOps không chạy ngang qua thẻ */
const REGISTRIES = new Set(["CONTAINER_REGISTRY", "ARTIFACT_REGISTRY"]);

export function SystemOverview({
  arch,
  projectId,
  selected,
  onSelect,
}: {
  arch: ArchitectureWire;
  projectId: string;
  selected: string | undefined;
  onSelect: (key: string) => void;
}) {
  const copy = useMessages(systemMessages);
  const [asTable, setAsTable] = useState(false);
  const links = systemLinks(
    new Set([USERS, GIT, ENVS, ...arch.tools.map((t) => t.domainType)]),
  );
  return (
    <>
      <SystemKpis arch={arch} projectId={projectId} />
      <div className="sys-bar">
        <span className="sys-legend">
          <span className="lg">
            <i className="sys-line" />
            {copy.legend.solid}
          </span>
          <span className="lg">
            <i className="sys-line dash" />
            {copy.legend.dashed}
          </span>
          <span className="c3">{copy.legend.note}</span>
        </span>
        <button
          type="button"
          className="btn"
          aria-pressed={asTable}
          onClick={() => setAsTable((v) => !v)}
        >
          {asTable ? copy.table.hide : copy.table.show}
        </button>
      </div>
      {asTable ? (
        <SystemTables arch={arch} links={links} />
      ) : (
        <SystemMap
          arch={arch}
          links={links}
          projectId={projectId}
          selected={selected}
          onSelect={onSelect}
        />
      )}
    </>
  );
}

// ------------------------------------------------------------------ sơ đồ

function SystemMap({
  arch,
  links,
  projectId,
  selected,
  onSelect,
}: {
  arch: ArchitectureWire;
  links: readonly SystemLink[];
  projectId: string;
  selected: string | undefined;
  onSelect: (key: string) => void;
}) {
  const copy = useMessages(systemMessages);
  // Callback ref qua state: lớp cạnh đo SAU khi khung đã gắn (xem `LinkLayer`)
  const [root, setRoot] = useState<HTMLDivElement | null>(null);
  const [hover, setHover] = useState<string | undefined>(undefined);
  const selectedDomain = arch.tools.find((t) => t.key === selected)?.domainType;

  const card = (t: ArchitectureToolWire) => (
    <ToolCard
      key={t.key}
      tool={t}
      selected={selected === t.key}
      onSelect={() => onSelect(t.key)}
      onHover={(on) => setHover(on ? t.domainType : undefined)}
    />
  );
  const zone = (z: SystemZone, children: ReactNode) => (
    <section className={`sys-zone sys-${z}`} aria-labelledby={`sys-${z}-h`}>
      <h3 id={`sys-${z}-h`} className="sys-zone-h">
        {copy.zone[z]}
      </h3>
      <div className="sys-zone-b">{children}</div>
    </section>
  );
  // Vùng chưa bật domain nào vẫn giữ chỗ trong bố cục cố định, và nói vì sao nó trống
  const tools = (z: SystemZone) => {
    const list = zoneTools(arch.tools, z);
    return list.length === 0 ? (
      <p className="c3 sys-empty">{copy.zoneEmpty}</p>
    ) : (
      list.map(card)
    );
  };

  const delivery = zoneTools(arch.tools, "delivery");
  const registries = delivery.filter((t) => REGISTRIES.has(t.domainType));
  const firstRegistry = registries[0];

  return (
    <div className="sys-scroll">
      <div className="sys-map" ref={setRoot}>
        {zone(
          "delivery",
          <>
            <Actor id={GIT} icon={GitCommitHorizontal} title={copy.git}>
              <span className="mono" translate="no">
                {copy.gitSub}
              </span>
            </Actor>
            {delivery.map((t) =>
              !REGISTRIES.has(t.domainType) ? (
                card(t)
              ) : t === firstRegistry ? (
                <div key="registries" className="sys-stack">
                  {registries.map(card)}
                </div>
              ) : null,
            )}
          </>,
        )}
        <div className="sys-users">
          <Actor id={USERS} icon={Users} title={copy.users}>
            {copy.usersSub}
          </Actor>
        </div>
        {zone("traffic", tools("traffic"))}
        <section
          className="sys-zone sys-envs"
          aria-labelledby="sys-envs-h"
          data-node={ENVS}
        >
          <h3 id="sys-envs-h" className="sys-zone-h">
            {copy.environments}
          </h3>
          <div className="sys-env-grid">
            {arch.environments.map((e) => (
              <EnvFrame key={e.id} env={e} projectId={projectId} />
            ))}
          </div>
        </section>
        {zone("data", tools("data"))}
        {zone("observe", tools("observe"))}
        {zone("govern", tools("govern"))}
        <LinkLayer
          container={root}
          links={links.map((l) => ({
            id: `${l.from}>${l.to}`,
            from: l.from,
            to: l.to,
            label: copy.link[l.kind],
            dashed: l.dashed,
            ...(VERTICAL.has(l.kind) ? { axis: "y" as const } : {}),
          }))}
          active={hover ?? selectedDomain}
          version={`${arch.generatedAt}:${String(arch.tools.length)}`}
          className="sys-links"
        />
      </div>
    </div>
  );
}

function Actor({
  id,
  icon,
  title,
  children,
}: {
  id: string;
  icon: LucideIcon;
  title: string;
  children: ReactNode;
}) {
  return (
    <div className="sys-actor" data-node={id}>
      <Icon of={icon} size={20} />
      <b>{title}</b>
      <span className="c3">{children}</span>
    </div>
  );
}

function ToolCard({
  tool,
  selected,
  onSelect,
  onHover,
}: {
  tool: ArchitectureToolWire;
  selected: boolean;
  onSelect: () => void;
  onHover: (on: boolean) => void;
}) {
  const health = toolHealth(tool);
  return (
    <button
      type="button"
      className={`sys-card tone-${health.tone}`}
      data-node={tool.domainType}
      aria-pressed={selected}
      onClick={onSelect}
      onMouseEnter={() => onHover(true)}
      onMouseLeave={() => onHover(false)}
      onFocus={() => onHover(true)}
      onBlur={() => onHover(false)}
    >
      <span className="sys-card-h">
        <Icon of={DOMAIN_ICON[tool.domainType] ?? Box} />
        <b>{tool.displayName}</b>
      </span>
      <span className="mono c3" translate="no">
        {tool.toolId}
        {tool.adapterVersion !== null && ` ${tool.adapterVersion}`}
      </span>
      <StatusLabel tone={health.tone}>{health.label}</StatusLabel>
    </button>
  );
}

function EnvFrame({
  env,
  projectId,
}: {
  env: ArchitectureWire["environments"][number];
  projectId: string;
}) {
  const copy = useMessages(systemMessages);
  const labels = useMessages(architectureMessages).diagram.workload;
  return (
    <section
      className="sys-env"
      data-env-production={env.isProduction ? "true" : undefined}
      aria-labelledby={`sys-env-${env.id}`}
    >
      <h4 id={`sys-env-${env.id}`}>
        <span translate="no">{env.name}</span>
        {env.isProduction && (
          <span className="chip soft">{copy.production}</span>
        )}
      </h4>
      <span className="mono c3 sys-ns" translate="no">
        {env.namespace}
      </span>
      {env.workloads.length === 0 ? (
        <p className="c3 sys-empty">{copy.noWorkloads}</p>
      ) : (
        <ul className="sys-wls">
          {env.workloads.map((w) => (
            <li key={w.name}>
              <Link
                className="sys-wl"
                to="/app/projects/$projectId/deployments"
                params={{ projectId }}
                search={{ env: env.id }}
                aria-label={copy.openDeploys(w.name, env.name)}
              >
                <b className="mono" translate="no">
                  {w.name}
                </b>
                {w.imageTag !== null && (
                  <span className="mono c3" translate="no">
                    {w.imageTag}
                  </span>
                )}
                <StatusLabel tone={WORKLOAD_TONE[w.lastEvent]}>
                  {labels[w.lastEvent]}
                </StatusLabel>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

// ------------------------------------------------------------------ bốn con số (QĐ-5)

function SystemKpis({
  arch,
  projectId,
}: {
  arch: ArchitectureWire;
  projectId: string;
}) {
  const copy = useMessages(systemMessages);
  const health = healthSummary(arch.tools);
  const workloads = arch.environments.reduce(
    (n, e) => n + e.workloads.length,
    0,
  );
  const success = arch.deploys.reduce((n, d) => n + d.success, 0);
  const failure = arch.deploys.reduce((n, d) => n + d.failure, 0);
  return (
    <section className="kpis sys-kpis" aria-label={copy.kpi.label}>
      <div className="kpi">
        <div className="l">{copy.kpi.tools}</div>
        <div className="v num">{formatNumber(arch.tools.length)}</div>
        <div className="c3">
          {copy.kpi.toolsSub(health.ok, health.warn, health.error)}
        </div>
      </div>
      <div className="kpi">
        <div className="l">{copy.kpi.workloads}</div>
        <div className="v num">{formatNumber(workloads)}</div>
        <div className="c3">
          {copy.kpi.workloadsSub(arch.environments.length)}
        </div>
      </div>
      <div className="kpi">
        <div className="l">{copy.kpi.deploys}</div>
        <div className="v num">{formatNumber(success + failure)}</div>
        <div className="c3">{copy.kpi.deploysSub(failure)}</div>
        <BarChart
          title={copy.kpi.deploys}
          level={3}
          height={44}
          captionHidden
          format={formatNumber}
          data={deployBars(arch.deploys, {
            success: copy.kpi.success,
            failure: copy.kpi.failure,
          })}
        />
      </div>
      <ProductionRed arch={arch} projectId={projectId} />
    </section>
  );
}

/**
 * RED của env production ĐẦU TIÊN (theo rank, cùng quy tắc E10) từ `GET /metrics/red` sẵn có. Project chưa có nguồn
 * `metrics.query` thì nói vậy và dẫn tới trang Domain — cùng trạng thái với trang Giám sát.
 */
function ProductionRed({
  arch,
  projectId,
}: {
  arch: ArchitectureWire;
  projectId: string;
}) {
  const copy = useMessages(systemMessages).kpi;
  const range = useMessages(monitoringMessages).range[DEFAULT_RED_RANGE];
  const prod = arch.environments.find((e) => e.isProduction);
  const red = useQuery({
    queryKey: qk.red(projectId, prod?.id ?? "", DEFAULT_RED_RANGE),
    queryFn: () =>
      monitoringApi.red(projectId, prod?.id ?? "", DEFAULT_RED_RANGE),
    enabled: prod !== undefined,
    retry: false,
  });
  const title = prod === undefined ? copy.redNone : copy.red(prod.name, range);

  const body = (): ReactNode => {
    if (prod === undefined) return <p className="c3">{copy.noProduction}</p>;
    if (red.isPending) return <p className="c3">{copy.redLoading}</p>;
    if (red.isError) {
      return (
        <p className="c3">
          {problemSlugOf(red.error) === DOMAIN_ERROR_SLUGS.metricsNotEnabled
            ? copy.noMetrics(
                <Link
                  to="/app/projects/$projectId/domains"
                  params={{ projectId }}
                >
                  {copy.toDomains}
                </Link>,
              )
            : copy.redError}
        </p>
      );
    }
    const now = redSummary(red.data.metrics.workloads);
    if (now.latencyP99Ms === null && now.requestRate === null) {
      return <p className="c3">{copy.noData(range)}</p>;
    }
    return (
      <>
        <div className="v num">{copy.p99(now.latencyP99Ms)}</div>
        <div className="c3">{copy.redSub(now.errorRatio, now.requestRate)}</div>
      </>
    );
  };

  return (
    <div className="kpi">
      <div className="l">{title}</div>
      {body()}
    </div>
  );
}

// ------------------------------------------------------------------ bản bảng thay thế (QĐ-6)

/** Cùng thông tin với sơ đồ, bằng hai bảng: trình đọc màn hình và màn hẹp đọc được, không cần lớp cạnh */
function SystemTables({
  arch,
  links,
}: {
  arch: ArchitectureWire;
  links: readonly SystemLink[];
}) {
  const copy = useMessages(systemMessages);
  const byDomain = new Map(arch.tools.map((t) => [t.domainType, t]));
  const nameOf = (id: string): string =>
    id === USERS
      ? copy.users
      : id === GIT
        ? copy.git
        : id === ENVS
          ? copy.environments
          : (byDomain.get(id)?.displayName ?? id);
  const zones = Object.keys(SYSTEM_ZONES) as SystemZone[];
  return (
    <div className="sys-tables">
      <div className="table-wrap">
        <table className="dtable">
          <caption>{copy.table.components}</caption>
          <thead>
            <tr>
              <th scope="col">{copy.table.zone}</th>
              <th scope="col">{copy.table.component}</th>
              <th scope="col">{copy.table.tool}</th>
              <th scope="col">{copy.table.status}</th>
            </tr>
          </thead>
          <tbody>
            {zones.flatMap((z) =>
              zoneTools(arch.tools, z).map((t) => {
                const health = toolHealth(t);
                return (
                  <tr key={t.key}>
                    <td>{copy.zone[z]}</td>
                    <th scope="row">{t.displayName}</th>
                    <td className="mono" translate="no">
                      {t.toolId}
                    </td>
                    <td>
                      <StatusLabel tone={health.tone}>
                        {health.label}
                      </StatusLabel>
                    </td>
                  </tr>
                );
              }),
            )}
            {arch.environments.map((e) => (
              <tr key={e.id}>
                <td>{copy.environments}</td>
                <th scope="row" translate="no">
                  {e.name}
                </th>
                <td className="mono" translate="no">
                  {e.namespace}
                </td>
                <td>{copy.table.workloads(e.workloads.length)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="table-wrap">
        <table className="dtable">
          <caption>{copy.table.connections}</caption>
          <thead>
            <tr>
              <th scope="col">{copy.table.from}</th>
              <th scope="col">{copy.table.to}</th>
              <th scope="col">{copy.table.role}</th>
              <th scope="col">{copy.table.line}</th>
            </tr>
          </thead>
          <tbody>
            {links.map((l) => (
              <tr key={`${l.from}>${l.to}`}>
                <th scope="row">{nameOf(l.from)}</th>
                <td>{nameOf(l.to)}</td>
                <td>{copy.link[l.kind]}</td>
                <td className="c3">
                  {l.dashed ? copy.legend.dashed : copy.legend.solid}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
