import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useParams } from "@tanstack/react-router";
import type {
  RolloutDetailWire,
  RolloutEventWire,
  RolloutIntentActionWire,
} from "@udp/shared-types/wire";
import { CircleAlert, CircleX, Pause, Play, Undo2, Upload } from "lucide-react";
import { useEffect, useState } from "react";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { Icon } from "../../components/Icon";
import { ErrorState, Loading } from "../../components/States";
import { toast } from "../../components/Toast";
import { messageOf } from "../../lib/errors";
import { formatDateTime, formatNumber, formatPercent } from "../../lib/format";
import { qk } from "../../lib/query-keys";
import { ProjectBar } from "../project/ProjectBar";
import { useProjectContext } from "../project/ProjectLayout";
import { can } from "../project/roles";
import { rolloutApi } from "./rollout-api";
import { RolloutStatusLabel } from "./rollout-status";

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

const ACTION_LABEL: Record<RolloutIntentActionWire, string> = {
  PAUSE: "Tạm dừng",
  RESUME: "Tiếp tục",
  PROMOTE: "Lên 100%",
  ROLLBACK: "Rollback",
};

/** Hành động hợp lệ theo trạng thái — ẩn nút vô nghĩa thay vì để backend trả 409 */
export function actionsFor(
  status: RolloutDetailWire["status"],
): RolloutIntentActionWire[] {
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
}

export function RolloutDetailPage() {
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
              Rollout
            </Link>
            <span className="sep"> / </span>
            {rollout.data?.rollout.flag?.key ?? rolloutId.slice(0, 8)}
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
  const { project } = useProjectContext();
  const snap = rollout.latestMetricSnapshot;
  const decision = rollout.lastDecision;
  const maxBreaches = Number(rollout.thresholds.maxConsecutiveBreaches ?? 2);
  const errorLimit = Number(rollout.thresholds.errorRate ?? 0.05);

  return (
    <>
      <div className="hero">
        <div className="t">
          <h1 className="title mono">
            {rollout.flag?.key ?? rollout.workloadName ?? "rollout"}
          </h1>
          <p className="lead">
            {rollout.flag !== undefined && (
              <>
                Tăng variant{" "}
                <span className="mono">{rollout.flag.targetVariant}</span>
                {" · "}
              </>
            )}
            {rollout.workloadName !== null && (
              <>
                workload <span className="mono">{rollout.workloadName}</span>
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
            <b>Hệ thống đã tự rollback</b>
            <div>{decision?.reason ?? "Metric vượt ngưỡng liên tiếp."}</div>
          </div>
        </div>
      )}
      {rollout.failReason === "DEPENDENCY_DOWN" && (
        <div className="alert" role="alert">
          <Icon of={CircleAlert} />
          <div>
            <b>Không rollback được vì Flag Service không phản hồi</b>
            <div>
              Cơ chế an toàn thất bại: kiểm tra ngay trạng thái của flag.
            </div>
          </div>
        </div>
      )}

      <WhyStill rollout={rollout} maxBreaches={maxBreaches} />

      <div className="stat">
        <div>
          <div className="l">Lưu lượng variant mới</div>
          <div className="v num">
            {formatPercent(rollout.currentTrafficPercentage)}
          </div>
        </div>
        <div>
          <div className="l">Mốc rollback</div>
          <div className="v num">
            {rollout.baselinePercentage === null
              ? "–"
              : formatPercent(rollout.baselinePercentage)}
          </div>
        </div>
        <div>
          <div className="l">Tỉ lệ lỗi canary / đối chứng</div>
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
          <div className="l">Latency P99 canary</div>
          <div className="v num">
            {snap?.canary.latencyP99Ms === undefined
              ? "–"
              : `${formatNumber(Math.round(snap.canary.latencyP99Ms))}`}
            <small>ms</small>
          </div>
        </div>
      </div>

      <div className="steps" aria-label="Tiến độ">
        <div className={rollout.status === "FAILED" ? "seg2 fail" : "seg2"}>
          <i
            style={{ width: `${String(rollout.currentTrafficPercentage)}%` }}
          />
        </div>
        <div className="lb">
          <span>
            Bậc <b>{formatPercent(rollout.stepPercent)}</b> mỗi{" "}
            {rollout.stepIntervalSeconds}s · đo lại mỗi{" "}
            {rollout.analysisIntervalSeconds}s
          </span>
          <b>{formatPercent(rollout.currentTrafficPercentage)}</b>
        </div>
      </div>

      <div className="grid2">
        <div>
          <ErrorChart events={rollout.events} limit={errorLimit} />
          {snap !== undefined && (
            <details className="cardc">
              <summary>Truy vấn PromQL đã chạy</summary>
              <div className="q mono">
                {[...snap.queries.canary, ...snap.queries.baseline].map((q) => (
                  <div key={q}>{q}</div>
                ))}
              </div>
              {snap.zScore !== null && (
                <p className="c3">z-score: {snap.zScore.toFixed(2)}</p>
              )}
            </details>
          )}
        </div>
        <div className="panel2">
          <h3 className="h2" style={{ marginTop: 10 }}>
            Nhật ký
          </h3>
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
  const fmt = (s: number) =>
    s >= 60
      ? `${String(Math.floor(s / 60))}m${String(s % 60)}s`
      : `${String(s)}s`;

  return (
    <div className="alert amber" role="status" aria-live="polite">
      <Icon of={CircleAlert} />
      <div>
        {rollout.pendingIntent !== undefined ? (
          <b>
            Đang thực hiện: {EVENT_LABEL[rollout.pendingIntent.action]} (yêu cầu
            bởi {rollout.pendingIntent.byUser || "một thành viên"})
          </b>
        ) : (
          <b>{decision?.reason ?? "Đang chờ lần đo đầu tiên."}</b>
        )}
        {decision?.breach === true && (
          <div>
            Vượt ngưỡng {decision.breachStreak}/{maxBreaches}
            {decision.breachStreak + 1 >= maxBreaches
              ? ", sẽ rollback nếu lần đo tới vẫn vượt"
              : ""}
          </div>
        )}
        {active && (
          <div className="c2">
            {nextAnalysis !== undefined && (
              <>Đo lại sau {fmt(nextAnalysis)} · </>
            )}
            Đủ thời gian giữ bậc sau {fmt(dwellLeft)}
          </div>
        )}
      </div>
    </div>
  );
}

function Actions({ rollout }: { rollout: RolloutDetailWire }) {
  const { project } = useProjectContext();
  const queryClient = useQueryClient();
  const [confirm, setConfirm] = useState<RolloutIntentActionWire | null>(null);

  const act = useMutation({
    mutationFn: (action: RolloutIntentActionWire) =>
      rolloutApi.act(project.id, rollout.id, action),
    onSuccess: async (_d, action) => {
      setConfirm(null);
      // 202: intent đã ghi, CHƯA thực thi (§7.6) — nút chuyển "Đang thực hiện..." qua pendingIntent
      toast.info(`Đã gửi yêu cầu: ${ACTION_LABEL[action]}`);
      await queryClient.invalidateQueries({
        queryKey: qk.rollout(project.id, rollout.id),
      });
    },
    onError: (e) => {
      if (confirm === null) toast.error(messageOf(e));
    },
  });

  const pending = rollout.pendingIntent !== undefined || act.isPending;
  const actions = actionsFor(rollout.status);
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
            ? "Đang thực hiện..."
            : ACTION_LABEL[a]}
        </button>
      ))}
      {confirm !== null && (
        <ConfirmDialog
          title={
            confirm === "ROLLBACK" ? "Rollback rollout này?" : "Đưa lên 100%?"
          }
          description={
            confirm === "ROLLBACK"
              ? `Lưu lượng về lại mốc ${rollout.baselinePercentage === null ? "ban đầu" : formatPercent(rollout.baselinePercentage)}.`
              : "Mọi người dùng khớp rule sẽ nhận variant mới."
          }
          confirmLabel={ACTION_LABEL[confirm]}
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

const EVENT_LABEL: Record<RolloutEventWire["action"], string> = {
  PROMOTE: "Lên bậc",
  ROLLBACK: "Rollback",
  PAUSE: "Tạm dừng",
  RESUME: "Tiếp tục",
  COMPLETE: "Hoàn tất",
  EXPIRE: "Hết hạn",
  DEPENDENCY_DOWN: "Phụ thuộc không phản hồi",
};

function EventFeed({ events }: { events: RolloutEventWire[] }) {
  if (events.length === 0) return <p className="c3">Chưa có sự kiện.</p>;
  return (
    <ul className="feed">
      {events.map((e) => (
        <li key={e.id}>
          <span className="ic" />
          <span>
            <b>
              {e.isIntent ? "Yêu cầu: " : ""}
              {EVENT_LABEL[e.action]}
            </b>{" "}
            {formatPercent(e.trafficPercentage)}
            {e.reason !== null && <div className="c3">{e.reason}</div>}
          </span>
          <span className="c3">{formatDateTime(e.createdAt)}</span>
        </li>
      ))}
    </ul>
  );
}

/**
 * Tỉ lệ lỗi canary so với đối chứng qua các lần đo có ghi snapshot, cùng vạch ngưỡng
 * (§10.13 "baseline + đối chứng"). Hai đường, ngưỡng nét đứt đỏ (DESIGN.md §6 "Biểu đồ").
 */
function ErrorChart({
  events,
  limit,
}: {
  events: RolloutEventWire[];
  limit: number;
}) {
  const points = events
    .filter((e) => e.metricSnapshot !== null)
    .map((e) => ({
      at: e.createdAt,
      canary: e.metricSnapshot?.canary.errorRate ?? 0,
      baseline: e.metricSnapshot?.baseline.errorRate ?? 0,
    }))
    .sort((a, b) => a.at.localeCompare(b.at));

  if (points.length < 2) {
    return (
      <div className="cardc">
        <div className="hd">
          <h3>Tỉ lệ lỗi</h3>
        </div>
        <p className="c3">Cần ít nhất hai lần đo để vẽ biểu đồ.</p>
      </div>
    );
  }
  const w = 600;
  const h = 190;
  const max = Math.max(
    limit * 1.5,
    ...points.map((p) => Math.max(p.canary, p.baseline)),
  );
  const x = (i: number) => (i / (points.length - 1)) * w;
  const y = (v: number) => h - (v / max) * (h - 10) - 5;
  const line = (key: "canary" | "baseline") =>
    points
      .map(
        (p, i) =>
          `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(p[key]).toFixed(1)}`,
      )
      .join(" ");

  return (
    <div className="cardc">
      <div className="hd">
        <h3>Tỉ lệ lỗi</h3>
        <div className="r">
          <span className="lg">
            <i style={{ background: "var(--accent)" }} />
            canary
          </span>
          <span className="lg">
            <i style={{ background: "var(--ink-4)" }} />
            đối chứng
          </span>
          <span className="lg">
            <i style={{ background: "var(--red)" }} />
            ngưỡng {formatPercent(limit * 100)}
          </span>
        </div>
      </div>
      <div className="chart">
        <svg
          viewBox={`0 0 ${String(w)} ${String(h)}`}
          role="img"
          aria-label="Biểu đồ tỉ lệ lỗi canary so với đối chứng"
        >
          <line
            x1={0}
            x2={w}
            y1={y(limit)}
            y2={y(limit)}
            stroke="var(--red)"
            strokeDasharray="4 4"
            strokeWidth={1}
          />
          <path
            d={line("baseline")}
            fill="none"
            stroke="var(--ink-4)"
            strokeDasharray="3 3"
            strokeWidth={1.5}
          />
          <path
            d={line("canary")}
            fill="none"
            stroke="var(--accent)"
            strokeWidth={2}
          />
        </svg>
      </div>
    </div>
  );
}
