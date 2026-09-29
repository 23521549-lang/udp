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

export const DEFAULT_RED_RANGE: RedRange = "6h";

const RANGE_LABEL: Record<RedRange, string> = {
  "1h": "1 giờ",
  "6h": "6 giờ",
  "24h": "24 giờ",
  "7d": "7 ngày",
};

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
      <ProjectBar title="Giám sát" />
      <div className="scroll">
        <PageHead
          title="Giám sát"
          lead={
            <>
              Request, lỗi và độ trễ của workload ở {env.name}, cùng lượt đánh
              giá flag, sức khoẻ domain và chỉ số deploy.
            </>
          }
          actions={
            <div className="seg" role="group" aria-label="Khoảng thời gian">
              {RED_RANGES.map((r) => (
                <button
                  key={r}
                  type="button"
                  aria-pressed={range === r}
                  onClick={() => setRange(r)}
                >
                  {RANGE_LABEL[r]}
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
              <h2 id="mon-dora">Deploy {DORA_DAYS} ngày</h2>
              <div className="r">
                <Link
                  to="/app/projects/$projectId/deployments"
                  params={{ projectId: project.id }}
                  search={{ env: env.id }}
                  className="btn"
                >
                  Lịch sử deploy
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
        <h2 id="mon-red">Workload</h2>
        {m !== undefined && (
          <span className="c3">
            Nguồn{" "}
            <span className="mono" translate="no">
              {/* Khoá `<domain>:<tool>` của binding: phần tool là thứ người dùng nhận ra */}
              {m.source.tool?.split(":")[1] ?? m.source.providerId}
            </span>
            , mỗi điểm {formatDuration(m.stepSeconds)}
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
              {m.console.label}
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
        <Empty title="Chưa có nguồn metrics">
          Bật domain Giám sát với Prometheus, VictoriaMetrics hay một dịch vụ
          SaaS (Datadog, New Relic, Dynatrace, Grafana Cloud) để thấy request,
          lỗi và độ trễ.{" "}
          <Link to="/app/projects/$projectId/domains" params={{ projectId }}>
            Tới trang Domain
          </Link>
        </Empty>
      ) : red.isError ? (
        <ErrorState error={red.error} onRetry={() => void red.refetch()} />
      ) : red.data.metrics.workloads.length === 0 ? (
        <Empty title="Chưa có workload nào">
          Workload hiện ở đây sau lần deploy đầu tiên qua UDP.
        </Empty>
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
  return (
    <div className="mon-console">
      <p className="c3">
        Công cụ giám sát chạy trong cluster và không có địa chỉ công khai. Chạy
        lệnh dưới đây rồi mở{" "}
        <span className="mono" translate="no">
          {c.localUrl}
        </span>
        .
      </p>
      <CodeBlock code={c.command} label={c.label} />
    </div>
  );
}

/** Mỗi workload ba biểu đồ nhỏ — nhiều workload trên một biểu đồ là nhiều hơn bốn chuỗi (DESIGN.md §2) */
function RedCharts({ metrics }: { metrics: RedMetricsWire }) {
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
          aria-label={`Workload ${w.workload}`}
        >
          <h3 className="mono" translate="no">
            {w.workload}
          </h3>
          <div className="red-grid">
            <LineChart
              title="Request mỗi giây"
              level={4}
              height={130}
              times={times}
              series={[
                {
                  key: "rps",
                  label: "Request/giây",
                  values: w.requestRate,
                  tone: "v3",
                },
              ]}
              format={formatDecimal}
            />
            <LineChart
              title="Tỉ lệ lỗi 5xx"
              level={4}
              height={130}
              times={times}
              series={[
                {
                  key: "err",
                  label: "Tỉ lệ lỗi",
                  values: w.errorRatio.map((v) =>
                    v === null ? null : v * 100,
                  ),
                  tone: "v3",
                },
              ]}
              format={formatPercent}
            />
            <LineChart
              title="Độ trễ p99"
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
        <h2 id="mon-flags">Lượt đánh giá flag</h2>
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
  const withStats = flags.filter((f) => f.stats !== undefined);
  if (flags.length === 0) {
    return <p className="c3">Project chưa có flag nào.</p>;
  }
  if (withStats.length === 0) {
    return (
      <p className="c3">
        Chưa đọc được số lượt đánh giá: dịch vụ đánh giá flag không trả lời.
      </p>
    );
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
        title="Tổng theo ngày, 14 ngày"
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
                label: "Lượt đánh giá",
                value: perDay[i] ?? 0,
                tone: "neutral",
              },
            ],
          };
        })}
      />
      <div>
        <h3 className="mon-sub">Dùng nhiều nhất 7 ngày</h3>
        {top.length === 0 ? (
          <p className="c3">Chưa flag nào được đánh giá trong 7 ngày.</p>
        ) : (
          <ol className="lst" aria-label="Flag dùng nhiều nhất">
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
          <p className="c3">
            Tính trên {flags.length} trong {total} flag.
          </p>
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
  const arch = useQuery({
    queryKey: qk.architecture(projectId),
    queryFn: () => architectureApi.get(projectId),
  });
  return (
    <section aria-labelledby="mon-health">
      <div className="sect">
        <h2 id="mon-health">Sức khoẻ domain</h2>
      </div>
      {arch.isPending ? (
        <Loading />
      ) : arch.isError ? (
        <ErrorState error={arch.error} onRetry={() => void arch.refetch()} />
      ) : arch.data.architecture.tools.length === 0 ? (
        <p className="c3">Project chưa bật domain nào.</p>
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
        <h2 id="mon-cost">Chi phí {COST_DAYS} ngày</h2>
        {cost.data !== undefined && (
          <span className="c3 num">
            Tổng {formatUsd(cost.data.cost.totalUsd)}
          </span>
        )}
      </div>
      {cost.isPending ? (
        <Loading />
      ) : notEnabled ? (
        <p className="c3">
          Chưa bật Cost Management.{" "}
          <Link to="/app/projects/$projectId/domains" params={{ projectId }}>
            Bật OpenCost hay Kubecost ở trang Domain
          </Link>
        </p>
      ) : cost.isError ? (
        <ErrorState error={cost.error} onRetry={() => void cost.refetch()} />
      ) : (
        <LineChart
          title="Chi phí theo ngày"
          level={3}
          times={cost.data.cost.daily.map((d) =>
            Date.parse(`${d.date}T00:00:00Z`),
          )}
          series={[
            {
              key: "usd",
              label: "Chi phí",
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
