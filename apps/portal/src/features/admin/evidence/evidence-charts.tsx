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
import type { ReactNode } from "react";
import {
  CategoryChart,
  type Category,
  type CategorySeries,
} from "../../../components/CategoryChart";
import { useMessages } from "../../../i18n";
import {
  compactNumber,
  formatDecimal,
  formatNumber,
  formatPercent,
} from "../../../lib/format";
import { evidenceMessages } from "./evidence.messages";

/**
 * [Plan #56 QĐ-5] Biểu đồ của từng phép đo có tệp thô. Mỗi hàm nhận `data` ĐÃ qua schema của phép đo
 * (`@udp/shared-types/measurements`) — không đọc trường nào schema không chốt. Mọi biểu đồ có bảng số liệu và nút
 * tải CSV (số thô) để vẽ lại trong luận văn.
 */

/** Vài con số lớn đầu thẻ — nhãn dưới, số trên */
export function Stats({
  items,
}: {
  items: readonly { value: ReactNode; label: string }[];
}) {
  return (
    <dl className="ev-stats">
      {items.map((it) => (
        <div key={it.label}>
          <dt>{it.label}</dt>
          <dd className="num">{it.value}</dd>
        </div>
      ))}
    </dl>
  );
}

export function E1Chart({ data }: { data: E1Data }) {
  const t = useMessages(evidenceMessages);
  const m = t.charts.e1;
  const categories: Category[] = data.batches.map((b, i) => ({
    key: b.commit,
    short: String(i + 1),
    label: `${String(i + 1)}. ${b.commit} ${b.subject}`,
  }));
  const series: CategorySeries[] = [
    {
      key: "inside",
      label: m.inside,
      values: data.batches.map((b) => b.files - b.outsideAdapters.length),
      tone: "baseline",
    },
    {
      key: "outside",
      label: m.outside,
      values: data.batches.map((b) => b.outsideAdapters.length),
      tone: "accent",
    },
  ];
  return (
    <>
      <Stats
        items={[
          { value: formatNumber(data.interfaceBreaks.count), label: m.breaks },
          {
            value: formatNumber(data.contractRelaxations),
            label: m.relaxations,
          },
          {
            value: t.rich.ofTotal(
              formatNumber(data.toolsAddedAfterTag),
              data.toolsAtHead,
            ),
            label: m.tools,
          },
          {
            value: formatDecimal(data.outsideAdaptersPerTool),
            label: m.perTool,
          },
        ]}
      />
      <CategoryChart
        title={m.batches}
        level={4}
        categories={categories}
        series={series}
        format={formatNumber}
        groupHeader={m.batch}
        csvFileName={t.csvName("E1", "batches")}
      />
    </>
  );
}

export function E3Chart({ data }: { data: E3Data }) {
  const t = useMessages(evidenceMessages);
  const m = t.charts.e3;
  const cells = [...data.local].sort(
    (a, b) => a.flags - b.flags || a.rulesPerFlag - b.rulesPerFlag,
  );
  const us = (v: number) => t.unit.us(formatDecimal(v));
  const ms = (v: number) => t.unit.ms(formatDecimal(v));
  return (
    <>
      <CategoryChart
        title={m.title}
        level={4}
        scale="log"
        categories={cells.map((c) => ({
          key: `${String(c.flags)}x${String(c.rulesPerFlag)}`,
          short: `${String(c.flags)}×${String(c.rulesPerFlag)}`,
          label: m.cellLabel(c.flags, c.rulesPerFlag),
        }))}
        series={[
          {
            key: "sdk50",
            label: m.sdkP50,
            values: cells.map((c) => c.sdkUs.p50),
            tone: "accent",
          },
          {
            key: "sdk99",
            label: m.sdkP99,
            values: cells.map((c) => c.sdkUs.p99),
            tone: "v3",
          },
          {
            key: "core50",
            label: m.coreP50,
            values: cells.map((c) => c.coreUs.p50),
            tone: "baseline",
          },
          {
            key: "core99",
            label: m.coreP99,
            values: cells.map((c) => c.coreUs.p99),
            tone: "v4",
          },
        ]}
        format={us}
        groupHeader={m.cell}
        csvFileName={t.csvName("E3", "latency-us")}
      />
      <p className="c3">
        {m.remote(ms(data.remote.latencyMs.p50), ms(data.remote.latencyMs.p99))}
      </p>
    </>
  );
}

export function E4Chart({ data }: { data: E4Data }) {
  const t = useMessages(evidenceMessages);
  const m = t.charts.e4;
  const flagCounts = [...new Set(data.cells.map((c) => c.flags))].sort(
    (a, b) => a - b,
  );
  const categories = flagCounts.map((n) => ({
    key: String(n),
    short: String(n),
    label: m.flagsLabel(n),
  }));
  const pick = (mode: "snapshot" | "delta", notify: boolean) =>
    flagCounts.map(
      (n) =>
        data.cells.find(
          (c) => c.flags === n && c.mode === mode && c.notify === notify,
        ) ?? null,
    );
  const modes = [
    { mode: "snapshot", notify: true, tone: "baseline" },
    { mode: "snapshot", notify: false, tone: "v4" },
    { mode: "delta", notify: true, tone: "accent" },
    { mode: "delta", notify: false, tone: "v3" },
  ] as const;
  return (
    <>
      <CategoryChart
        title={m.latency}
        level={4}
        categories={categories}
        series={modes.map((x) => ({
          key: `${x.mode}-${String(x.notify)}`,
          label: m.mode(x.mode, x.notify),
          values: pick(x.mode, x.notify).map((c) => c?.latencyMs.p50 ?? null),
          tone: x.tone,
        }))}
        format={(v) => t.unit.ms(formatNumber(Math.round(v)))}
        groupHeader={m.flags}
        csvFileName={t.csvName("E4", "latency-p50-ms")}
      />
      <CategoryChart
        title={m.bytes}
        level={4}
        scale="log"
        categories={categories}
        series={(["snapshot", "delta"] as const).map((mode) => ({
          key: mode,
          label: m.mode(mode, true),
          values: pick(mode, true).map(
            (c) => c?.serverBytesPerChange.median ?? null,
          ),
          tone: mode === "delta" ? "accent" : "baseline",
        }))}
        format={(v) => t.unit.bytes(compactNumber(v))}
        groupHeader={m.flags}
        csvFileName={t.csvName("E4", "bytes-per-change")}
      />
    </>
  );
}

/** "10/90" từ tỉ lệ mong muốn — nhãn không phụ thuộc ngôn ngữ của tên kịch bản (dữ liệu của harness) */
const splitOf = (s: E7Data["scenarios"][number]): string =>
  s.variants
    .map((v) => formatNumber(Math.round(v.expectedShare * 100)))
    .join("/");

export function E7Chart({ data }: { data: E7Data }) {
  const t = useMessages(evidenceMessages);
  const m = t.charts.e7;
  const variants = data.scenarios.flatMap((s) =>
    s.variants.map((v) => ({ scenario: s, variant: v })),
  );
  return (
    <>
      <CategoryChart
        title={m.title}
        level={4}
        categories={data.scenarios.map((s) => ({
          key: s.name,
          short: splitOf(s),
          label: `${s.name} (N = ${formatNumber(s.n)}, df = ${String(s.df)})`,
        }))}
        series={[
          {
            key: "chi2",
            label: m.chi2,
            values: data.scenarios.map((s) => s.chi2),
            tone: "accent",
          },
          {
            key: "critical",
            label: m.critical,
            values: data.scenarios.map((s) => s.critical),
            tone: "baseline",
          },
        ]}
        format={formatDecimal}
        groupHeader={m.scenario}
        csvFileName={t.csvName("E7", "chi-square")}
      />
      <CategoryChart
        title={m.shares}
        level={4}
        categories={variants.map(({ scenario, variant }) => ({
          key: `${scenario.name}-${variant.key}`,
          short: `${splitOf(scenario)} ${variant.key}`,
          label: `${scenario.name} · ${variant.key}`,
        }))}
        series={[
          {
            key: "observed",
            label: m.observed,
            values: variants.map((x) => x.variant.observedShare * 100),
            tone: "accent",
          },
          {
            key: "expected",
            label: m.expected,
            values: variants.map((x) => x.variant.expectedShare * 100),
            tone: "baseline",
          },
        ]}
        format={formatPercent}
        groupHeader={m.variant}
        csvFileName={t.csvName("E7", "shares")}
      />
    </>
  );
}

export function E8Chart({ data }: { data: E8Data }) {
  const t = useMessages(evidenceMessages);
  const m = t.charts.e8;
  const byDifferential = data.results.filter(
    (r) => r.killedByDifferential,
  ).length;
  const bySuiteOnly = data.results.filter(
    (r) => !r.killedByDifferential && r.killedBySuite,
  ).length;
  return (
    <>
      <Stats
        items={[
          {
            value: t.rich.ofTotal(
              formatNumber(data.mutants - data.survivors.length),
              data.mutants,
            ),
            label: m.title,
          },
          {
            value: t.rich.ofTotal(formatNumber(data.oracleCodes), 7),
            label: m.oracle,
          },
        ]}
      />
      <CategoryChart
        title={m.title}
        level={4}
        categories={[
          {
            key: "differential",
            short: m.byDifferential,
            label: m.byDifferential,
          },
          { key: "suite", short: m.bySuiteOnly, label: m.bySuiteOnly },
          { key: "survived", short: m.survived, label: m.survived },
        ]}
        series={[
          {
            key: "mutants",
            label: m.title,
            values: [byDifferential, bySuiteOnly, data.survivors.length],
            tone: "accent",
          },
        ]}
        format={formatNumber}
        groupHeader={m.title}
        csvFileName={t.csvName("E8", "mutants")}
      />
    </>
  );
}

export function E14Chart({ data }: { data: E14Data }) {
  const t = useMessages(evidenceMessages);
  const m = t.charts.e14;
  const cells = [...data.cells].sort((a, b) => a.T - b.T || a.V - b.V);
  return (
    <>
      <CategoryChart
        title={m.title}
        level={4}
        scale="log"
        categories={cells.map((c) => ({
          key: `${String(c.T)}-${String(c.V)}`,
          short: `${String(c.T)},${String(c.V)}`,
          label: `T = ${String(c.T)}, V = ${String(c.V)}`,
        }))}
        series={[
          {
            key: "predicted",
            label: m.predicted,
            values: cells.map((c) => c.predicted.total),
            tone: "baseline",
          },
          {
            key: "complete",
            label: m.complete,
            values: cells.map((c) => c.complete.series.total),
            tone: "accent",
          },
          {
            key: "realistic",
            label: m.realistic,
            values: cells.map((c) => c.realistic.series.total),
            tone: "v3",
          },
        ]}
        format={compactNumber}
        groupHeader={m.cell}
        csvFileName={t.csvName("E14", "series")}
      />
      <p className="c3 mono">{m.formula(data.method.formula)}</p>
    </>
  );
}

export function I34Chart({ data }: { data: I34Data }) {
  const t = useMessages(evidenceMessages);
  const m = t.charts.i34;
  const s = (v: number) => t.unit.s(formatDecimal(v));
  return (
    <>
      <CategoryChart
        title={m.title}
        level={4}
        categories={data.phases.map((p, i) => ({
          key: String(i),
          short: String(i + 1),
          label: `${String(i + 1)}. ${p.phase}`,
        }))}
        series={[
          {
            key: "converged",
            label: m.converged,
            values: data.phases.map((p) => p.convergedAfterRestoreSeconds),
            tone: "accent",
          },
          {
            key: "limit",
            label: m.limit,
            values: data.phases.map((p) => p.convergeLimitSeconds),
            tone: "baseline",
          },
        ]}
        format={s}
        groupHeader={m.phase}
        csvFileName={t.csvName("I34", "convergence")}
      />
      <ul className="c3 ev-list">
        {data.phases.map((p, i) => (
          <li key={p.phase}>
            {`${String(i + 1)}. `}
            {m.wrong(p.wrongOrErrorDuringOutage, p.evaluationsDuringOutage)}
          </li>
        ))}
      </ul>
    </>
  );
}

export function FlagListChart({ data }: { data: FlagListData }) {
  const t = useMessages(evidenceMessages);
  const m = t.charts.flagList;
  const routes = [
    { key: "page", label: m.page, v: data.page },
    { key: "count", label: m.count, v: data.count },
    { key: "full", label: m.full, v: data.fullList },
  ];
  return (
    <CategoryChart
      title={m.title}
      level={4}
      categories={routes.map((r) => ({
        key: r.key,
        short: r.label,
        label: r.label,
      }))}
      series={[
        {
          key: "p50",
          label: "p50",
          values: routes.map((r) => r.v.p50Ms),
          tone: "baseline",
        },
        {
          key: "p95",
          label: "p95",
          values: routes.map((r) => r.v.p95Ms),
          tone: "accent",
        },
        {
          key: "p99",
          label: "p99",
          values: routes.map((r) => r.v.p99Ms),
          tone: "v3",
        },
      ]}
      format={(v) => t.unit.ms(formatNumber(Math.round(v)))}
      threshold={{ value: data.thresholdMs, label: m.threshold }}
      groupHeader={m.route}
      csvFileName={t.csvName("portal-pagination", "latency-ms")}
    />
  );
}
