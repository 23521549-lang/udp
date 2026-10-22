import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useParams } from "@tanstack/react-router";
import type {
  RolloutDetailWire,
  RolloutEventWire,
  RolloutIntentActionWire,
} from "@udp/shared-types/wire";
import {
  CircleAlert,
  CircleCheck,
  CircleX,
  LoaderCircle,
  Pause,
  Play,
  Undo2,
  Upload,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useState } from "react";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { Icon } from "../../components/Icon";
import { InfoTip } from "../../components/InfoTip";
import { LineChart } from "../../components/LineChart";
import { ErrorState, Loading } from "../../components/States";
import { toast } from "../../components/Toast";
import { messagesOf, useMessages } from "../../i18n";
import { messageOf } from "../../lib/errors";
import {
  formatDateTime,
  formatDecimal,
  formatDuration,
  formatNumber,
  formatPercent,
} from "../../lib/format";
import { qk } from "../../lib/query-keys";
import { ProjectBar } from "../project/ProjectBar";
import { useProjectContext } from "../project/ProjectLayout";
import { can } from "../project/roles";
import { decisionReason } from "./decision-reason";
import { rolloutApi } from "./rollout-api";
import { RolloutStatusLabel } from "./rollout-status";
import { rolloutMessages } from "./rollout.messages";

/**
 * Nhịp hỏi lại theo trạng thái (§10.9, §10.14): 5s khi đang chạy hay đang chờ nhãn
 * `ff`, 10s khi tạm dừng, DỪNG HẲN khi kết thúc — một tab mở quên không được poll mãi.
 */
export function pollIntervalOf(
  status: RolloutDetailWire["status"] | undefined,
): number | false {
  switch (status) {
    case "IN_PROGRESS":
    case "PENDING":
      return 5_000;
    case "PAUSED":
      return 10_000;
    default:
      return false;
  }
}

/**
 * [Plan #46] Nhãn theo chiến lược: PROMOTE của ATTRIBUTE_SPLIT là đổi variant mặc định (§7.2), không
 * phải "lên 100%" của một rule. Chữ đọc theo ngôn ngữ lúc gọi (Plan #54).
 */
function labelOf(
  action: RolloutIntentActionWire,
  rollout: RolloutDetailWire,
): string {
  const m = messagesOf(rolloutMessages).detail;
  if (
    action === "PROMOTE" &&
    rollout.scope === "FLAG_LEVEL" &&
    rollout.strategy === "ATTRIBUTE_SPLIT"
  ) {
    return m.makeDefault(rollout.flag?.targetVariant);
  }
  return m.action[action];
}

/**
 * Hành động hợp lệ theo trạng thái — ẩn nút vô nghĩa thay vì để backend trả 409. [Plan #51] tool-driven: công
 * cụ tự chạy, dừng nó cần sửa spec mà Service 3 không có quyền (§12.2) — không có Tạm dừng/Tiếp tục.
 */
export function actionsFor(
  status: RolloutDetailWire["status"],
  controlMode: RolloutDetailWire["controlMode"] = "udp-driven",
): RolloutIntentActionWire[] {
  const actions = ((): RolloutIntentActionWire[] => {
    switch (status) {
      case "IN_PROGRESS":
        return ["PAUSE", "PROMOTE", "ROLLBACK"];
      case "PAUSED":
        return ["RESUME", "PROMOTE", "ROLLBACK"];
      case "PENDING":
        return ["ROLLBACK"];
      default:
        return [];
    }
  })();
  return controlMode === "tool-driven"
    ? actions.filter((a) => a !== "PAUSE" && a !== "RESUME")
    : actions;
}

/**
 * [Plan #58 UX-6] Sắc của dải "vì sao đang đứng yên" theo ĐÚNG quyết định gần nhất — trước đây luôn cam, kể cả khi
 * mọi số đo trong ngưỡng. Chờ số đo hay đang thực hiện yêu cầu: trung tính; trong ngưỡng: ổn; vượt ngưỡng: cảnh báo,
 * và lỗi khi lần vượt tới sẽ tự lùi lại.
 */
export type DecisionTone = "neutral" | "ok" | "warn" | "error";

export function decisionTone(
  rollout: Pick<RolloutDetailWire, "lastDecision" | "pendingIntent">,
  maxBreaches: number,
): DecisionTone {
  const d = rollout.lastDecision;
  if (rollout.pendingIntent !== undefined || d === undefined) return "neutral";
  if (d.decision === "ROLLBACK") return "error";
  if (d.breach) return d.breachStreak + 1 >= maxBreaches ? "error" : "warn";
  // HOLD không vượt ngưỡng là còn chờ dữ liệu (chưa đủ request), chưa phải "ổn"
  return d.decision === "PROMOTE" ? "ok" : "neutral";
}

const TONE: Record<DecisionTone, { className: string; icon: LucideIcon }> = {
  neutral: { className: "alert neutral", icon: LoaderCircle },
  ok: { className: "alert ok", icon: CircleCheck },
  warn: { className: "alert amber", icon: CircleAlert },
  error: { className: "alert", icon: CircleX },
};

export function RolloutDetailPage() {
  const m = useMessages(rolloutMessages);
  const { project, env } = useProjectContext();
  const { rolloutId } = useParams({
    from: "/app/projects/$projectId/rollouts/$rolloutId",
  });
  const rollout = useQuery({
    queryKey: qk.rollout(project.id, rolloutId),
    queryFn: () => rolloutApi.get(project.id, rolloutId),
    staleTime: 0,
    refetchInterval: (q) => pollIntervalOf(q.state.data?.rollout.status),
    refetchOnWindowFocus: (q) =>
      pollIntervalOf(q.state.data?.rollout.status) !== false,
  });

  return (
    <>
      <ProjectBar
        title={
          <>
            <Link
              to="/app/projects/$projectId/rollouts"
              params={{ projectId: project.id }}
              search={{ env: env.id }}
              className="c3"
            >
              {m.list.title}
            </Link>
            <span className="sep"> / </span>
            {rollout.data?.rollout.flag?.key ??
              rollout.data?.rollout.workloadName ??
              rolloutId.slice(0, 8)}
          </>
        }
        envScoped={false}
      />
      <div className="scroll">
        <div className="page">
          {rollout.isPending ? (
            <Loading />
          ) : rollout.isError ? (
            <ErrorState
              error={rollout.error}
              onRetry={() => void rollout.refetch()}
              back={
                <Link
                  to="/app/projects/$projectId/rollouts"
                  params={{ projectId: project.id }}
                  search={{ env: env.id }}
                  className="btn"
                >
                  {m.detail.back}
                </Link>
              }
            />
          ) : (
            <RolloutBody rollout={rollout.data.rollout} />
          )}
        </div>
      </div>
    </>
  );
}

function RolloutBody({ rollout }: { rollout: RolloutDetailWire }) {
  const m = useMessages(rolloutMessages).detail;
  const { project } = useProjectContext();
  const snap = rollout.latestMetricSnapshot;
  // [Plan #46] §10.9 AttributeSplitDetail: số KỸ THUẬT của hai nhánh, không tự quyết, không z-score
  const split = rollout.strategy === "ATTRIBUTE_SPLIT";
  // [Plan #51] SERVICE_LEVEL: hai nhánh là hai PHIÊN BẢN, không phải hai variant của một flag
  const service = rollout.scope === "SERVICE_LEVEL";
  const decision = rollout.lastDecision;
  const maxBreaches = Number(rollout.thresholds.maxConsecutiveBreaches ?? 2);
  const errorLimit = Number(rollout.thresholds.errorRate ?? 0.05);

  return (
    <>
      <div className="hero">
        <div className="t">
          <h1 className="title mono" translate="no">
            {rollout.flag?.key ?? rollout.workloadName ?? m.fallbackTitle}
          </h1>
          <p className="lead">
            {rollout.flag !== undefined && (
              <>
                {m.rampVariant(
                  <span className="mono" translate="no">
                    {rollout.flag.targetVariant}
                  </span>,
                )}
                {" · "}
              </>
            )}
            {service && (
              <>
                {m.versionChange(
                  <span className="mono" translate="no">
                    {rollout.versionOld ?? "?"}
                  </span>,
                  <span className="mono" translate="no">
                    {rollout.versionNew ?? "?"}
                  </span>,
                )}
                {" · "}
                {m.mode[rollout.controlMode]}
                {" · "}
              </>
            )}
            {rollout.workloadName !== null && (
              <>
                {m.workload(
                  <span className="mono" translate="no">
                    {rollout.workloadName}
                  </span>,
                )}
                {" · "}
              </>
            )}
            {rollout.environment.name}
          </p>
          <RolloutStatusLabel
            status={rollout.status}
            percent={rollout.currentTrafficPercentage}
          />
        </div>
        {can(project.myRole, "MAINTAINER") && <Actions rollout={rollout} />}
      </div>

      {rollout.failReason === "AUTO_ROLLBACK" && (
        <div className="alert" role="alert">
          <Icon of={CircleX} />
          <div>
            <b>{m.autoRollback}</b>
            <div>
              {decisionReason(decision?.detail, decision?.reason) ??
                m.autoRollbackReason}
            </div>
          </div>
        </div>
      )}
      {rollout.failReason === "DEPENDENCY_DOWN" && (
        <div className="alert" role="alert">
          <Icon of={CircleAlert} />
          <div>
            <b>{service ? m.abortFailed : m.rollbackFailed}</b>
            <div>{service ? m.abortFailedHint : m.rollbackFailedHint}</div>
          </div>
        </div>
      )}

      {service && rollout.trafficMatch !== undefined && (
        <p className="c2">
          {m.trafficMatch(
            <span className="mono">
              {rollout.trafficMatch.header}: {rollout.trafficMatch.value}
            </span>,
          )}
        </p>
      )}
      {service && rollout.controlMode === "tool-driven" && (
        <div className="alert" role="note">
          <Icon of={CircleAlert} />
          <div>
            <b>{m.toolDriven}</b>
            <div>{m.toolDrivenHint}</div>
          </div>
        </div>
      )}
      {split && !service && (
        <div className="alert" role="note">
          <Icon of={CircleAlert} />
          <div>
            <b>{m.splitNote}</b>
            <div>{m.splitNoteHint}</div>
          </div>
        </div>
      )}
      <WhyStill rollout={rollout} maxBreaches={maxBreaches} />

      <div className="stat">
        <div>
          <div className="l">
            {service
              ? m.traffic.service
              : split
                ? m.traffic.split
                : m.traffic.flag}
          </div>
          <div className="v num">
            {formatPercent(rollout.currentTrafficPercentage)}
          </div>
        </div>
        <div>
          <div className="l">{m.baseline}</div>
          <div className="v num">
            {rollout.baselinePercentage === null
              ? "–"
              : formatPercent(rollout.baselinePercentage)}
          </div>
        </div>
        <div>
          <div className="l">
            {service
              ? m.errorRates.service
              : split
                ? m.errorRates.split
                : m.errorRates.flag}
            {!split && (
              <>
                <InfoTip term="canary" />
                <InfoTip term="baseline" />
              </>
            )}
          </div>
          <div className="v num">
            {snap === undefined
              ? "–"
              : `${formatPercent(snap.canary.errorRate * 100)}`}
            <small>
              {snap === undefined
                ? ""
                : `/ ${formatPercent(snap.baseline.errorRate * 100)}`}
            </small>
          </div>
        </div>
        <div>
          <div className="l">
            {m.latency}
            <InfoTip term="p99" />
          </div>
          <div className="v num">
            {snap?.canary.latencyP99Ms === undefined
              ? "–"
              : `${formatNumber(Math.round(snap.canary.latencyP99Ms))}`}
            <small>{m.ms}</small>
          </div>
        </div>
      </div>

      <div className="steps">
        <div
          className={rollout.status === "FAILED" ? "seg2 fail" : "seg2"}
          role="progressbar"
          aria-label={m.progress}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={rollout.currentTrafficPercentage}
          aria-valuetext={formatPercent(rollout.currentTrafficPercentage)}
        >
          <i
            style={{ width: `${String(rollout.currentTrafficPercentage)}%` }}
          />
        </div>
        <div className="lb">
          <span>
            {m.cadence(
              <b>{formatPercent(rollout.stepPercent)}</b>,
              formatDuration(rollout.stepIntervalSeconds),
              formatDuration(rollout.analysisIntervalSeconds),
            )}
            <InfoTip term="step" />
          </span>
          <b>{formatPercent(rollout.currentTrafficPercentage)}</b>
        </div>
      </div>

      <div className="grid2">
        <div>
          <ErrorChart
            events={rollout.events}
            latest={snap}
            limit={errorLimit}
          />
          {snap !== undefined && (
            <details className="cardc">
              <summary>{m.promql}</summary>
              <div className="q mono">
                {[...snap.queries.canary, ...snap.queries.baseline].map((q) => (
                  <div key={q}>{q}</div>
                ))}
              </div>
              {!split && snap.zScore !== null && (
                <p className="c3">{m.zScore(formatDecimal(snap.zScore))}</p>
              )}
            </details>
          )}
        </div>
        <div className="panel2">
          <h2 className="h2" style={{ marginTop: 10 }}>
            {m.log}
          </h2>
          <EventFeed events={rollout.events} />
        </div>
      </div>
    </>
  );
}

/**
 * "Vì sao đang đứng yên" (§10.12 B10, §10.13): lý do của quyết định gần nhất, chuỗi
 * vượt ngưỡng, và HAI đồng hồ tách rời — đo lại sau bao lâu và đủ dwell sau bao lâu. Màn
 * hình đứng yên 5 phút mà không nói gì trông như treo.
 */
function WhyStill({
  rollout,
  maxBreaches,
}: {
  rollout: RolloutDetailWire;
  maxBreaches: number;
}) {
  const m = useMessages(rolloutMessages).detail;
  const [now, setNow] = useState(() => Date.now());
  const active =
    rollout.status === "IN_PROGRESS" || rollout.status === "PENDING";
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [active]);

  const decision = rollout.lastDecision;
  if (!active && rollout.pendingIntent === undefined) return null;

  const nextAnalysis =
    decision === undefined
      ? undefined
      : Math.max(
          0,
          Math.round(
            (new Date(decision.at).getTime() +
              rollout.analysisIntervalSeconds * 1000 -
              now) /
              1000,
          ),
        );
  const lastStep = [...rollout.events]
    .filter((e) => e.action === "PROMOTE" && !e.isIntent)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  const stepStart = new Date(
    lastStep?.createdAt ?? rollout.createdAt,
  ).getTime();
  const dwellLeft = Math.max(
    0,
    Math.round((stepStart + rollout.stepIntervalSeconds * 1000 - now) / 1000),
  );
  const tone = TONE[decisionTone(rollout, maxBreaches)];
  /*
   * Chỉ LÝ DO (đổi vài phút một lần) nằm trong vùng aria-live; hai đồng hồ đếm từng giây ở ngoài nó —
   * nếu không trình đọc màn hình đọc lại cả khối mỗi giây.
   */
  return (
    <div className={tone.className}>
      <Icon of={tone.icon} />
      <div>
        <div role="status" aria-live="polite">
          {rollout.pendingIntent !== undefined ? (
            <b>
              {m.inProgressBy(
                m.event[rollout.pendingIntent.action],
                rollout.pendingIntent.byUser || m.aMember,
              )}
            </b>
          ) : (
            <b>
              {decisionReason(decision?.detail, decision?.reason) ??
                m.waitingFirst}
            </b>
          )}
          {/* [Plan #60 QĐ-1] Lý do có mã đã nói "lần mấy/bao nhiêu": dòng dưới chỉ còn hệ quả của lần tới */}
          {decision?.breach === true &&
            (decision.detail?.code === "BREACH" ? (
              decision.breachStreak + 1 >= maxBreaches && (
                <div>
                  {m.breachLast}
                  <InfoTip term="autoRollback" />
                </div>
              )
            ) : (
              <div>
                {m.breach(
                  decision.breachStreak,
                  maxBreaches,
                  decision.breachStreak + 1 >= maxBreaches,
                )}
                <InfoTip term="autoRollback" />
              </div>
            ))}
        </div>
        {active && (
          <div className="c2 num">
            {nextAnalysis !== undefined &&
              (nextAnalysis === 0
                ? m.nextAnalysisNow
                : m.nextAnalysis(formatDuration(nextAnalysis)))}
            {/* [Plan #58 UX-6] Hết giờ giữ bậc KHÔNG có nghĩa được lên bậc khi số đo đang vượt ngưỡng */}
            {dwellLeft > 0
              ? m.dwellLeft(formatDuration(dwellLeft))
              : decision?.breach === true
                ? m.dwellDoneHeld
                : m.dwellDone}
            <InfoTip term="dwell" />
          </div>
        )}
      </div>
    </div>
  );
}

function Actions({ rollout }: { rollout: RolloutDetailWire }) {
  const m = useMessages(rolloutMessages).detail;
  const { project } = useProjectContext();
  const queryClient = useQueryClient();
  const [confirm, setConfirm] = useState<RolloutIntentActionWire | null>(null);

  const act = useMutation({
    mutationFn: (action: RolloutIntentActionWire) =>
      rolloutApi.act(project.id, rollout.id, action),
    onSuccess: async (_d, action) => {
      setConfirm(null);
      // 202: intent đã ghi, CHƯA thực thi (§7.6) — nút chuyển "Đang thực hiện..." qua pendingIntent
      const copy = messagesOf(rolloutMessages).detail;
      toast.info(copy.requestSent(copy.action[action]));
      await queryClient.invalidateQueries({
        queryKey: qk.rollout(project.id, rollout.id),
      });
    },
    onError: (e) => {
      if (confirm === null) toast.error(messageOf(e));
    },
  });

  const pending = rollout.pendingIntent !== undefined || act.isPending;
  const actions = actionsFor(rollout.status, rollout.controlMode);
  const service = rollout.scope === "SERVICE_LEVEL";
  if (actions.length === 0) return null;

  const icon: Record<RolloutIntentActionWire, typeof Pause> = {
    PAUSE: Pause,
    RESUME: Play,
    PROMOTE: Upload,
    ROLLBACK: Undo2,
  };

  return (
    <div className="acts">
      {actions.map((a) => (
        <button
          key={a}
          type="button"
          className={a === "ROLLBACK" ? "btn danger" : "btn"}
          disabled={pending}
          onClick={() => {
            // Việc nặng cần xác nhận (DESIGN.md §6): rollback và lên 100%
            if (a === "ROLLBACK" || a === "PROMOTE") setConfirm(a);
            else act.mutate(a);
          }}
        >
          <Icon of={icon[a]} />
          {pending && rollout.pendingIntent?.action === a
            ? m.working
            : labelOf(a, rollout)}
        </button>
      ))}
      {confirm !== null && (
        <ConfirmDialog
          title={
            confirm === "ROLLBACK"
              ? m.confirmRollback
              : !service && rollout.strategy === "ATTRIBUTE_SPLIT"
                ? m.confirmMakeDefault
                : m.confirmPromote
          }
          description={
            service
              ? confirm === "ROLLBACK"
                ? m.serviceRollback(rollout.versionOld)
                : m.servicePromote(rollout.versionNew)
              : confirm === "ROLLBACK"
                ? m.flagRollback(
                    rollout.baselinePercentage === null
                      ? null
                      : formatPercent(rollout.baselinePercentage),
                  )
                : rollout.strategy === "ATTRIBUTE_SPLIT"
                  ? m.splitPromote
                  : m.flagPromote
          }
          confirmLabel={labelOf(confirm, rollout)}
          danger={confirm === "ROLLBACK"}
          busy={act.isPending}
          error={act.isError ? messageOf(act.error) : undefined}
          onConfirm={() => act.mutate(confirm)}
          onClose={() => {
            setConfirm(null);
            act.reset();
          }}
        />
      )}
    </div>
  );
}

function EventFeed({ events }: { events: RolloutEventWire[] }) {
  const m = useMessages(rolloutMessages).detail;
  if (events.length === 0) return <p className="c3">{m.noEvents}</p>;
  return (
    <ul className="feed">
      {events.map((e) => (
        <li key={e.id}>
          <span className="ic" />
          <span>
            <b>
              {e.isIntent ? m.requestPrefix : ""}
              {m.event[e.action]}
            </b>{" "}
            {formatPercent(e.trafficPercentage)}
            {(e.reason !== null || e.reasonDetail !== null) && (
              <div className="c3">
                {decisionReason(e.reasonDetail, e.reason)}
              </div>
            )}
          </span>
          <span className="c3">{formatDateTime(e.createdAt)}</span>
        </li>
      ))}
    </ul>
  );
}

/**
 * Tỉ lệ lỗi canary so với đối chứng qua các lần đo có ghi snapshot, cùng ngưỡng (§10.13 "baseline +
 * đối chứng"; DESIGN.md §6 "Biểu đồ", "Trục biểu đồ"). Dùng `LineChart` chung: thang co theo dữ liệu,
 * nên canary 0,4% không còn nằm dẹt dưới đáy vì thang bị kéo tới ngưỡng 5%.
 */
/**
 * Tỉ lệ lỗi theo thời gian: các lần đo gắn với sự kiện (lên bậc, lùi lại…) cộng [Plan #58] lần đo MỚI NHẤT của bộ
 * điều phối. Quyết định giữ bậc (HOLD) không phải một sự kiện, nên thiếu điểm cuối thì biểu đồ nằm dưới ngưỡng trong
 * lúc dải quyết định báo đang vượt — hai thứ trên cùng một trang nói ngược nhau.
 */
function ErrorChart({
  events,
  latest,
  limit,
}: {
  events: RolloutEventWire[];
  latest: RolloutEventWire["metricSnapshot"] | undefined;
  limit: number;
}) {
  const m = useMessages(rolloutMessages).detail;
  const snapshots = events.flatMap((e) =>
    e.metricSnapshot === null ? [] : [e.metricSnapshot],
  );
  if (
    latest !== undefined &&
    latest !== null &&
    !snapshots.some((s) => s.at === latest.at)
  ) {
    snapshots.push(latest);
  }
  const points = snapshots
    .map((snap) => ({
      at: new Date(snap.at).getTime(),
      canary: snap.canary.errorRate * 100,
      baseline: snap.baseline.errorRate * 100,
    }))
    .sort((a, b) => a.at - b.at);

  if (points.length === 0) {
    return (
      <div className="cardc">
        <div className="hd">
          <h2>{m.errorRate}</h2>
        </div>
        <p className="c3">{m.noMeasurements}</p>
      </div>
    );
  }
  return (
    <div className="cardc">
      <LineChart
        title={m.errorRate}
        level={2}
        times={points.map((p) => p.at)}
        series={[
          {
            key: "canary",
            label: m.canary,
            tone: "accent",
            values: points.map((p) => p.canary),
          },
          {
            key: "baseline",
            label: m.control,
            tone: "baseline",
            values: points.map((p) => p.baseline),
          },
        ]}
        threshold={{
          value: limit * 100,
          label: m.threshold(formatPercent(limit * 100)),
        }}
        format={formatPercent}
      />
    </div>
  );
}
