import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import { DOMAIN_ERROR_SLUGS } from "@udp/shared-types/domain-api";
import {
  RED_RANGES,
  type MonitoringConsoleWire,
  type RedMetricsWire,
  type RedRange,
} from "@udp/shared-types/wire";
import { ExternalLink } from "lucide-react";
import { BarChart } from "../../components/BarChart";
import { CodeBlock } from "../../components/CodeBlock";
import { Icon } from "../../components/Icon";
import { LineChart } from "../../components/LineChart";
import { PageHead } from "../../components/PageHead";
import { Sparkline } from "../../components/Sparkline";
import { Empty, ErrorState, Loading } from "../../components/States";
import { useMessages } from "../../i18n";
import { problemSlugOf } from "../../lib/errors";
import {
  browserTimeZone,
  compactNumber,
  dayLabel,
  formatDecimal,
  formatDuration,
  formatNumber,
  formatPercent,
  formatUsd,
  lastDays,
} from "../../lib/format";
import { qk } from "../../lib/query-keys";
import { architectureApi } from "../architecture/architecture-api";
import { DomainHealthGrid } from "../architecture/DomainHealthGrid";
import { deploymentApi } from "../deployment/deployment-api";
import { DoraCards } from "../deployment/DoraCards";
import { flagApi } from "../flag/flag-api";
import { ProjectBar } from "../project/ProjectBar";
import { useProjectContext } from "../project/ProjectLayout";
import { can } from "../project/roles";
import { provisioningApi } from "../provisioning/provisioning-api";
import { monitoringApi } from "./monitoring-api";
import { monitoringMessages } from "./monitoring.messages";

export const DEFAULT_RED_RANGE: RedRange = "6h";

/** DORA và chi phí đọc cửa sổ 30 ngày — cùng khoá cache với mặc định của trang Deploy và Hạ tầng */
const DORA_DAYS = 30;
const COST_DAYS = 30;
const TOP_FLAGS = 5;

/**
 * Giám sát (Plan #53 QĐ-4, QĐ-7): thứ project đang chạy ở MỘT environment — request, lỗi và độ trễ
 * của từng workload theo thời gian, lượt đánh giá flag, sức khoẻ domain, DORA, xu hướng chi phí, và
 * lối sang công cụ giám sát. Mỗi phần tải và báo lỗi riêng: nguồn metrics chưa bật không che mất
 * lượt đánh giá flag.
 */
export function MonitoringPage() {
  const m = useMessages(monitoringMessages);
  const { project, env } = useProjectContext();
  const search = useSearch({ from: "/app/projects/$projectId/monitoring" });
  const navigate = useNavigate({ from: "/app/projects/$projectId/monitoring" });
  const range = search.range ?? DEFAULT_RED_RANGE;

  const setRange = (next: RedRange): void => {
    void navigate({
      search: (prev) => {
        const { range: _drop, ...rest } = prev;
        return next === DEFAULT_RED_RANGE ? rest : { ...rest, range: next };
      },
      replace: true,
    });
  };

  return (
    <>
      <ProjectBar title={m.title} />
      <div className="scroll">
        <PageHead
          title={m.title}
          lead={m.lead(env.name)}
          actions={
            <div className="seg" role="group" aria-label={m.rangeLabel}>
              {RED_RANGES.map((r) => (
                <button
                  key={r}
                  type="button"
                  aria-pressed={range === r}
                  onClick={() => setRange(r)}
                >
                  {m.range[r]}
                </button>
              ))}
            </div>
          }
        />
        <div className="page">
          <RedSection projectId={project.id} envId={env.id} range={range} />
          <FlagEvaluations projectId={project.id} envId={env.id} />
          <HealthSection projectId={project.id} envId={env.id} />
          <section aria-labelledby="mon-dora">
            <div className="sect">
              <h2 id="mon-dora">{m.doraTitle(DORA_DAYS)}</h2>
              <div className="r">
                <Link
                  to="/app/projects/$projectId/deployments"
                  params={{ projectId: project.id }}
                  search={{ env: env.id }}
                  className="btn"
                >
                  {m.deployHistory}
                </Link>
              </div>
            </div>
            <DoraSummary projectId={project.id} envId={env.id} />
          </section>
          {can(project.myRole, "MAINTAINER") && (
            <CostTrend projectId={project.id} />
          )}
        </div>
      </div>
    </>
  );
}

// ------------------------------------------------------------------ RED

function RedSection({
  projectId,
  envId,
  range,
}: {
  projectId: string;
  envId: string;
  range: RedRange;
}) {
  const copy = useMessages(monitoringMessages).red;
  const red = useQuery({
    queryKey: qk.red(projectId, envId, range),
    queryFn: () => monitoringApi.red(projectId, envId, range),
    retry: false,
    refetchInterval: 60_000,
  });
  const notEnabled =
    red.isError &&
    problemSlugOf(red.error) === DOMAIN_ERROR_SLUGS.metricsNotEnabled;
  const m = red.data?.metrics;

  return (
    <section aria-labelledby="mon-red">
      <div className="sect">
        <h2 id="mon-red">{copy.title}</h2>
        {m !== undefined && (
          <span className="c3">
            {copy.source(
              <span className="mono" translate="no">
                {/* Khoá `<domain>:<tool>` của binding: phần tool là thứ người dùng nhận ra */}
                {m.source.tool?.split(":")[1] ?? m.source.providerId}
              </span>,
              formatDuration(m.stepSeconds),
            )}
          </span>
        )}
        {m?.console?.kind === "url" && (
          <div className="r">
            <a
              className="btn"
              href={m.console.url}
              target="_blank"
              rel="noreferrer"
            >
              {copy.openApp[m.console.app]}
              <Icon of={ExternalLink} />
            </a>
          </div>
        )}
      </div>
      {m?.console?.kind === "portForward" && (
        <PortForward console={m.console} />
      )}
      {red.isPending ? (
        <Loading />
      ) : notEnabled ? (
        <Empty title={copy.noMetricsTitle}>
          {copy.noMetrics(
            <Link to="/app/projects/$projectId/domains" params={{ projectId }}>
              {copy.toDomains}
            </Link>,
          )}
        </Empty>
      ) : red.isError ? (
        <ErrorState error={red.error} onRetry={() => void red.refetch()} />
      ) : red.data.metrics.workloads.length === 0 ? (
        <Empty title={copy.noWorkloadsTitle}>{copy.noWorkloads}</Empty>
      ) : (
        <RedCharts metrics={red.data.metrics} />
      )}
    </section>
  );
}

function PortForward({
  console: c,
}: {
  console: Extract<MonitoringConsoleWire, { kind: "portForward" }>;
}) {
  const copy = useMessages(monitoringMessages).red;
  return (
    <div className="mon-console">
      <p className="c3">
        {copy.portForward(
          <span className="mono" translate="no">
            {c.localUrl}
          </span>,
        )}
      </p>
      <CodeBlock code={c.command} label={copy.openApp[c.app]} />
    </div>
  );
}

/** Mỗi workload ba biểu đồ nhỏ — nhiều workload trên một biểu đồ là nhiều hơn bốn chuỗi (DESIGN.md §2) */
function RedCharts({ metrics }: { metrics: RedMetricsWire }) {
  const copy = useMessages(monitoringMessages).red;
  const t0 = Date.parse(metrics.start);
  const times = Array.from(
    { length: metrics.points },
    (_, i) => t0 + i * metrics.stepSeconds * 1000,
  );
  return (
    <div className="red-list">
      {metrics.workloads.map((w) => (
        <section
          key={w.workload}
          className="red-row"
          aria-label={copy.workload(w.workload)}
        >
          <h3 className="mono" translate="no">
            {w.workload}
          </h3>
          <div className="red-grid">
            <LineChart
              title={copy.requestRate}
              level={4}
              height={130}
              times={times}
              series={[
                {
                  key: "rps",
                  label: copy.requestRateSeries,
                  values: w.requestRate,
                  tone: "v3",
                },
              ]}
              format={formatDecimal}
            />
            <LineChart
              title={copy.errorRate}
              level={4}
              height={130}
              times={times}
              series={[
                {
                  key: "err",
                  label: copy.errorRateSeries,
                  values: w.errorRatio.map((v) =>
                    v === null ? null : v * 100,
                  ),
                  tone: "v3",
                },
              ]}
              format={formatPercent}
            />
            <LineChart
              title={copy.latency}
              level={4}
              height={130}
              times={times}
              series={[
                {
                  key: "p99",
                  label: "p99",
                  values: w.latencyP99Ms,
                  tone: "v3",
                },
              ]}
              format={(v) => `${formatNumber(Math.round(v))} ms`}
            />
          </div>
        </section>
      ))}
    </div>
  );
}

// ------------------------------------------------------------------ Flag

/**
 * Lượt đánh giá flag lấy từ CHÍNH trang đầu của danh sách flag (`include=stats`, QĐ-4) — cùng khoá
 * cache với trang Flag. Project nhiều flag hơn một trang thì câu dưới biểu đồ nói rõ con số tính trên
 * bao nhiêu flag, không ngầm coi đó là tổng.
 */
function FlagEvaluations({
  projectId,
  envId,
}: {
  projectId: string;
  envId: string;
}) {
  const copy = useMessages(monitoringMessages).flags;
  const tz = browserTimeZone();
  const flags = useQuery({
    queryKey: qk.flags(projectId, envId, "stats", { term: "", offset: 0 }),
    queryFn: () =>
      flagApi.page(projectId, envId, tz, {
        search: "",
        offset: 0,
        stats: true,
      }),
    staleTime: 10_000,
  });

  return (
    <section aria-labelledby="mon-flags">
      <div className="sect">
        <h2 id="mon-flags">{copy.title}</h2>
      </div>
      {flags.isPending ? (
        <Loading />
      ) : flags.isError ? (
        <ErrorState error={flags.error} onRetry={() => void flags.refetch()} />
      ) : (
        <FlagEvalBody
          projectId={projectId}
          envId={envId}
          flags={flags.data.flags}
          total={flags.data.total}
        />
      )}
    </section>
  );
}

function FlagEvalBody({
  projectId,
  envId,
  flags,
  total,
}: {
  projectId: string;
  envId: string;
  flags: Awaited<ReturnType<typeof flagApi.page>>["flags"];
  total: number;
}) {
  const copy = useMessages(monitoringMessages).flags;
  const withStats = flags.filter((f) => f.stats !== undefined);
  if (flags.length === 0) {
    return <p className="c3">{copy.none}</p>;
  }
  if (withStats.length === 0) {
    return <p className="c3">{copy.noStats}</p>;
  }
  const days = lastDays(14);
  const perDay = days.map((_, i) =>
    withStats.reduce((s, f) => s + (f.stats?.daily14[i] ?? 0), 0),
  );
  const top = [...withStats]
    .sort((a, b) => (b.stats?.evalCount7d ?? 0) - (a.stats?.evalCount7d ?? 0))
    .slice(0, TOP_FLAGS)
    .filter((f) => (f.stats?.evalCount7d ?? 0) > 0);
  return (
    <div className="mon-flags">
      <BarChart
        title={copy.daily}
        level={3}
        format={formatNumber}
        data={days.map((d, i) => {
          const label = dayLabel(d);
          return {
            key: d,
            short: label.short,
            full: label.full,
            parts: [
              {
                label: copy.evaluations,
                value: perDay[i] ?? 0,
                tone: "neutral",
              },
            ],
          };
        })}
      />
      <div>
        <h3 className="mon-sub">{copy.topTitle}</h3>
        {top.length === 0 ? (
          <p className="c3">{copy.topNone}</p>
        ) : (
          <ol className="lst" aria-label={copy.topList}>
            {top.map((f) => (
              <li key={f.id} className="it">
                <Link
                  to="/app/projects/$projectId/flags"
                  params={{ projectId }}
                  search={{ env: envId, flag: f.id }}
                  className="mono"
                  translate="no"
                >
                  {f.key}
                </Link>
                <span className="lst-end">
                  <Sparkline values={f.stats?.daily14 ?? []} />
                  <span className="num">
                    {compactNumber(f.stats?.evalCount7d ?? 0)}
                  </span>
                </span>
              </li>
            ))}
          </ol>
        )}
        {total > flags.length && (
          <p className="c3">{copy.basedOn(flags.length, total)}</p>
        )}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ Domain, DORA, chi phí

function HealthSection({
  projectId,
  envId,
}: {
  projectId: string;
  envId: string;
}) {
  const copy = useMessages(monitoringMessages).health;
  const arch = useQuery({
    queryKey: qk.architecture(projectId),
    queryFn: () => architectureApi.get(projectId),
  });
  return (
    <section aria-labelledby="mon-health">
      <div className="sect">
        <h2 id="mon-health">{copy.title}</h2>
      </div>
      {arch.isPending ? (
        <Loading />
      ) : arch.isError ? (
        <ErrorState error={arch.error} onRetry={() => void arch.refetch()} />
      ) : arch.data.architecture.tools.length === 0 ? (
        <p className="c3">{copy.none}</p>
      ) : (
        <DomainHealthGrid
          projectId={projectId}
          tools={arch.data.architecture.tools}
          env={envId}
        />
      )}
    </section>
  );
}

function DoraSummary({
  projectId,
  envId,
}: {
  projectId: string;
  envId: string;
}) {
  const dora = useQuery({
    queryKey: qk.dora(projectId, envId, DORA_DAYS),
    queryFn: () => deploymentApi.dora(projectId, envId, DORA_DAYS),
  });
  if (dora.isPending) return <Loading />;
  if (dora.isError) {
    return (
      <ErrorState error={dora.error} onRetry={() => void dora.refetch()} />
    );
  }
  return <DoraCards dora={dora.data.dora} />;
}

function CostTrend({ projectId }: { projectId: string }) {
  const copy = useMessages(monitoringMessages).cost;
  const cost = useQuery({
    queryKey: qk.cost(projectId, COST_DAYS),
    queryFn: () => provisioningApi.cost(projectId, COST_DAYS),
    retry: false,
  });
  const notEnabled =
    cost.isError &&
    problemSlugOf(cost.error) === DOMAIN_ERROR_SLUGS.costNotEnabled;
  return (
    <section aria-labelledby="mon-cost">
      <div className="sect">
        <h2 id="mon-cost">{copy.title(COST_DAYS)}</h2>
        {cost.data !== undefined && (
          <span className="c3 num">
            {copy.total(formatUsd(cost.data.cost.totalUsd))}
          </span>
        )}
      </div>
      {cost.isPending ? (
        <Loading />
      ) : notEnabled ? (
        <p className="c3">
          {copy.notEnabled(
            <Link to="/app/projects/$projectId/domains" params={{ projectId }}>
              {copy.enableLink}
            </Link>,
          )}
        </p>
      ) : cost.isError ? (
        <ErrorState error={cost.error} onRetry={() => void cost.refetch()} />
      ) : (
        <LineChart
          title={copy.daily}
          level={3}
          times={cost.data.cost.daily.map((d) =>
            Date.parse(`${d.date}T00:00:00Z`),
          )}
          series={[
            {
              key: "usd",
              label: copy.series,
              values: cost.data.cost.daily.map((d) => d.totalUsd),
              tone: "v3",
            },
          ]}
          format={formatUsd}
        />
      )}
    </section>
  );
}
