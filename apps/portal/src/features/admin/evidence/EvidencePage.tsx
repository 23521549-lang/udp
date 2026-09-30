import { useQuery } from "@tanstack/react-query";
import { useNavigate, useSearch } from "@tanstack/react-router";
import type {
  E1Data,
  E14Data,
  E3Data,
  E4Data,
  E7Data,
  E8Data,
  FlagListData,
  I34Data,
} from "@udp/shared-types/measurements";
import {
  EVIDENCE_DORA_DAYS,
  type EvidenceDoraDays,
  type PlatformDoraWire,
} from "@udp/shared-types/wire";
import { BarChart } from "../../../components/BarChart";
import { componentsMessages } from "../../../components/components.messages";
import { ErrorState, Loading } from "../../../components/States";
import { InfoTip } from "../../../components/InfoTip";
import { StatusLabel, type Tone } from "../../../components/StatusLabel";
import { useMessages } from "../../../i18n";
import { downloadText, toCsv } from "../../../lib/download";
import {
  formatDateTime,
  formatDayMonth,
  formatDecimal,
  formatDuration,
  formatNumber,
  formatPercent,
} from "../../../lib/format";
import { qk } from "../../../lib/query-keys";
import { deployBars } from "../../deployment/deploy-bars";
import { AdminPage } from "../AdminLayout";
import { adminApi } from "../admin-api";
import {
  E14Chart,
  E1Chart,
  E3Chart,
  E4Chart,
  E7Chart,
  E8Chart,
  FlagListChart,
  I34Chart,
} from "./evidence-charts";
import { evidenceMessages, type ExperimentText } from "./evidence.messages";
import {
  EVIDENCE_GROUPS,
  EXPERIMENTS,
  isDesignExperiment,
  statusOf,
  type EvidenceStatus,
  type Experiment,
} from "./experiments";
import { loadMeasurements, type LoadedMeasurement } from "./measurements";

/**
 * [Plan #56] `/admin/evidence` — Bằng chứng thực nghiệm (§14). Một thẻ cho mỗi phép đo, nhóm theo đóng góp: trạng
 * thái suy từ sổ thí nghiệm và từ việc có tệp thô; số tĩnh đọc từ tệp thô (chunk riêng, nạp khi mở trang); E10 là
 * số sống từ Service 1. Mỗi con số có nguồn — tệp, commit, cây sạch hay không, máy, hình học mạng — và tải về được.
 */

const TONE: Record<EvidenceStatus, Tone> = {
  measured: "ok",
  partial: "warn",
  live: "ok",
  pending: "unknown",
  people: "unknown",
};

export function EvidencePage() {
  const m = useMessages(evidenceMessages);
  const measurements = useQuery({
    queryKey: qk.measurements(),
    queryFn: loadMeasurements,
    staleTime: Number.POSITIVE_INFINITY,
  });

  const loaded = measurements.data;
  const statusOfId = (e: Experiment): EvidenceStatus =>
    statusOf(e, loaded?.has(e.id) ?? false);
  const design = EXPERIMENTS.filter(isDesignExperiment);
  const withData = design.filter((e) =>
    ["measured", "partial", "live"].includes(statusOfId(e)),
  );
  const backed = (["C1", "C2", "C3"] as const).filter(
    (c) => withData.filter((e) => e.supports.includes(c)).length >= 2,
  );
  const debts = new Set(EXPERIMENTS.flatMap((e) => e.debts));
  const latest = [...(loaded?.values() ?? [])]
    .map((x) => x.envelope?.at)
    .filter((at): at is string => at !== undefined)
    .sort()
    .pop();

  return (
    <AdminPage
      title={m.title}
      lead={m.lead}
      minis={
        loaded === undefined
          ? undefined
          : [
              {
                value: m.rich.ofTotal(
                  formatNumber(withData.length),
                  design.length,
                ),
                label: m.minis.measured(withData.length),
              },
              {
                value: m.rich.ofTotal(formatNumber(backed.length), 3),
                label: m.minis.contributions(backed.length),
              },
              {
                value: formatNumber(debts.size),
                label: m.minis.debts(debts.size),
              },
              {
                value:
                  latest === undefined
                    ? "–"
                    : formatDayMonth(Date.parse(latest)),
                label: m.minis.latest,
              },
            ]
      }
    >
      {measurements.isPending ? (
        <Loading />
      ) : measurements.isError ? (
        <ErrorState
          error={measurements.error}
          onRetry={() => void measurements.refetch()}
        />
      ) : (
        EVIDENCE_GROUPS.map((group) => (
          <section key={group} aria-labelledby={`ev-${group}`}>
            <h2 className="h2" id={`ev-${group}`}>
              {m.group[group]}
            </h2>
            {EXPERIMENTS.filter((e) => e.group === group).map((e) => (
              <EvidenceCard
                key={e.id}
                experiment={e}
                status={statusOfId(e)}
                measurement={measurements.data.get(e.id)}
              />
            ))}
          </section>
        ))
      )}
    </AdminPage>
  );
}

function EvidenceCard({
  experiment,
  status,
  measurement,
}: {
  experiment: Experiment;
  status: EvidenceStatus;
  measurement: LoadedMeasurement | undefined;
}) {
  const m = useMessages(evidenceMessages);
  const text: ExperimentText = m.experiment[experiment.id];
  const headingId = `ev-card-${experiment.id}`;
  return (
    <article className="cardc ev" aria-labelledby={headingId}>
      <div className="hd">
        <h3 id={headingId}>
          <span translate="no">{experiment.id}</span> · {text.title}
        </h3>
        {/* [Plan #58 UX-19] Số sống của E10 là DORA: giải thích ngay tại chỗ */}
        {experiment.source === "live" && <InfoTip term="dora" />}
        <div className="r">
          <StatusLabel tone={TONE[status]}>{m.status[status]}</StatusLabel>
        </div>
      </div>
      <p>{text.proves}</p>
      {experiment.supports.length > 0 && (
        <p className="c3">{m.supports(experiment.supports.join(", "))}</p>
      )}
      {experiment.source === "live" ? (
        <DoraEvidence />
      ) : measurement !== undefined ? (
        <MeasuredBody measurement={measurement} />
      ) : (
        text.needs !== undefined && <p className="c3">{text.needs}</p>
      )}
      {experiment.debts.length > 0 && (
        <p className="c3 ev-debts">{m.debts(experiment.debts.join(", "))}</p>
      )}
    </article>
  );
}

function MeasuredBody({ measurement }: { measurement: LoadedMeasurement }) {
  const m = useMessages(evidenceMessages);
  return (
    <>
      {measurement.problem !== null ? (
        <div className="state" role="alert">
          <b>{m.broken(measurement.file)}</b>
          <span className="c3 mono">{measurement.problem}</span>
        </div>
      ) : (
        <Chart measurement={measurement} />
      )}
      <Source measurement={measurement} />
    </>
  );
}

/** Biểu đồ riêng theo phép đo — `data` đã qua schema của đúng phép đo đó ở `measurements.ts` */
function Chart({ measurement }: { measurement: LoadedMeasurement }) {
  const m = useMessages(evidenceMessages);
  const d = measurement.data;
  switch (measurement.experiment) {
    case "E1":
      return <E1Chart data={d as E1Data} />;
    case "E3":
      return <E3Chart data={d as E3Data} />;
    case "E4":
      return <E4Chart data={d as E4Data} />;
    case "E7":
      return <E7Chart data={d as E7Data} />;
    case "E8":
      return <E8Chart data={d as E8Data} />;
    case "E14":
      return <E14Chart data={d as E14Data} />;
    case "I34":
      return <I34Chart data={d as I34Data} />;
    case "portal-pagination":
      return <FlagListChart data={d as FlagListData} />;
    default:
      return <p className="c3">{m.noChart}</p>;
  }
}

/** Nguồn của con số — thứ biến một biểu đồ thành bằng chứng kiểm lại được */
function Source({ measurement }: { measurement: LoadedMeasurement }) {
  const m = useMessages(evidenceMessages).source;
  const env = measurement.envelope?.environment;
  const parts = [
    `${m.file} ${measurement.file}`,
    ...(measurement.envelope === null
      ? []
      : [m.measuredAt(formatDateTime(measurement.envelope.at))]),
    ...(env === undefined
      ? []
      : [
          m.commit(env.commit.slice(0, 7)),
          env.sourceDirty
            ? m.dirty(env.sourceDiffSha256.slice(0, 12))
            : m.clean,
          env.geometry,
          m.machine(env.cpu, env.cpuCount, formatDecimal(env.freeMemoryGiB)),
          ...(env.note === undefined ? [] : [env.note]),
        ]),
    ...(measurement.earlier.length === 0
      ? []
      : [m.earlier(measurement.earlier.length)]),
  ];
  return (
    <div className="ev-src">
      <p className="c3">{parts.join(" · ")}</p>
      <button
        type="button"
        className="btn"
        onClick={() =>
          downloadText(measurement.file, "application/json", measurement.text)
        }
      >
        {m.downloadRaw}
      </button>
    </div>
  );
}

/** E10 — số sống: DORA của env production mỗi project, và deploy theo ngày trên cả nền tảng */
function DoraEvidence() {
  const t = useMessages(evidenceMessages);
  const m = t.charts.e10;
  const search = useSearch({ from: "/admin/evidence" });
  const navigate = useNavigate();
  const days: EvidenceDoraDays = search.days ?? 30;
  const dora = useQuery({
    queryKey: qk.adminEvidenceDora(days),
    queryFn: () => adminApi.evidenceDora(days),
  });
  return (
    <>
      <div className="envtabs" role="tablist" aria-label={m.window}>
        {EVIDENCE_DORA_DAYS.map((d) => (
          <button
            key={d}
            type="button"
            role="tab"
            aria-selected={d === days}
            onClick={() =>
              void navigate({
                to: "/admin/evidence",
                search: d === 30 ? {} : { days: d },
                replace: true,
                resetScroll: false,
              })
            }
          >
            {m.days(d)}
          </button>
        ))}
      </div>
      {dora.isPending ? (
        <Loading />
      ) : dora.isError ? (
        <ErrorState error={dora.error} onRetry={() => void dora.refetch()} />
      ) : (
        <DoraBody evidence={dora.data.evidence} />
      )}
    </>
  );
}

function DoraBody({ evidence }: { evidence: PlatformDoraWire }) {
  const t = useMessages(evidenceMessages);
  const downloadCsv = useMessages(componentsMessages).chart.csv;
  const m = t.charts.e10;
  const active = evidence.projects.filter(
    (p) => p.dora.changeFailureRate.total > 0,
  );
  const idle = evidence.projects.length - active.length;
  const csv = (): string =>
    toCsv(
      [
        m.project,
        m.deployments,
        m.frequency,
        `${m.leadTime} (s)`,
        m.failureRate,
        `${m.recovery} (s)`,
      ],
      active.map((p) => [
        p.projectName,
        p.dora.deployments,
        p.dora.deploymentFrequencyPerDay,
        p.dora.leadTimeSeconds.median,
        p.dora.changeFailureRate.value,
        p.dora.recoveryTimeSeconds.median,
      ]),
    );
  return (
    <>
      <BarChart
        title={m.daily}
        level={4}
        data={deployBars(evidence.daily, {
          success: m.success,
          failure: m.failure,
        })}
        format={formatNumber}
      />
      {active.length === 0 ? (
        <p className="c3">{m.none}</p>
      ) : (
        <>
          <h4 className="ev-h4">{m.table}</h4>
          <div className="table-wrap">
            <table className="dtable">
              <thead>
                <tr>
                  <th scope="col">{m.project}</th>
                  <th scope="col" className="num">
                    {m.deployments}
                  </th>
                  <th scope="col" className="num">
                    {m.frequency}
                  </th>
                  <th scope="col" className="num">
                    {m.leadTime}
                  </th>
                  <th scope="col" className="num">
                    {m.failureRate}
                  </th>
                  <th scope="col" className="num">
                    {m.recovery}
                  </th>
                </tr>
              </thead>
              <tbody>
                {active.map((p) => (
                  <tr key={p.projectId}>
                    <th scope="row" translate="no">
                      {p.projectName}
                    </th>
                    <td className="num">{formatNumber(p.dora.deployments)}</td>
                    <td className="num">
                      {t.unit.perDay(
                        formatDecimal(p.dora.deploymentFrequencyPerDay),
                      )}
                    </td>
                    <td className="num">
                      {formatDuration(p.dora.leadTimeSeconds.median)}
                    </td>
                    <td className="num">
                      {p.dora.changeFailureRate.value === null
                        ? "–"
                        : formatPercent(p.dora.changeFailureRate.value * 100)}
                    </td>
                    <td className="num">
                      {formatDuration(p.dora.recoveryTimeSeconds.median)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="ev-src">
            {idle > 0 ? <p className="c3">{m.idle(idle)}</p> : <span />}
            <button
              type="button"
              className="btn"
              onClick={() =>
                downloadText(
                  t.csvName("E10", `dora-${String(evidence.window.days)}d`),
                  "text/csv;charset=utf-8",
                  csv(),
                )
              }
            >
              {downloadCsv}
            </button>
          </div>
        </>
      )}
    </>
  );
}
