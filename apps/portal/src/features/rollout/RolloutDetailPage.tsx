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
import { LineChart } from "../../components/LineChart";
import { ErrorState, Loading } from "../../components/States";
import { toast } from "../../components/Toast";
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

/**
 * [Plan #46] Nhãn theo chiến lược: PROMOTE của ATTRIBUTE_SPLIT là đổi variant mặc định (§7.2), không
 * phải "lên 100%" của một rule.
 */
function labelOf(
  action: RolloutIntentActionWire,
  rollout: RolloutDetailWire,
): string {
  if (
    action === "PROMOTE" &&
    rollout.scope === "FLAG_LEVEL" &&
    rollout.strategy === "ATTRIBUTE_SPLIT"
  ) {
    return `Đổi mặc định sang ${rollout.flag?.targetVariant ?? "variant mới"}`;
  }
  return ACTION_LABEL[action];
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

const MODE_LABEL: Record<RolloutDetailWire["controlMode"], string> = {
  "udp-driven": "UDP quyết",
  "tool-driven": "công cụ tự quyết",
};

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
                  Về danh sách rollout
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
            {service && (
              <>
                Phiên bản{" "}
                <span className="mono">{rollout.versionOld ?? "?"}</span> →{" "}
                <span className="mono">{rollout.versionNew ?? "?"}</span>
                {" · "}
                {MODE_LABEL[rollout.controlMode]}
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
            <b>
              {service
                ? "Không abort được vì không vào được cluster của project"
                : "Không rollback được vì Flag Service không phản hồi"}
            </b>
            <div>
              {service
                ? "Kiểm tra ngay Rollout/Canary của workload trong cluster."
                : "Cơ chế an toàn thất bại: kiểm tra ngay trạng thái của flag."}
            </div>
          </div>
        </div>
      )}

      {service && rollout.trafficMatch !== undefined && (
        <p className="c2">
          Nhóm đi phiên bản mới: request có header{" "}
          <span className="mono">
            {rollout.trafficMatch.header}: {rollout.trafficMatch.value}
          </span>
        </p>
      )}
      {service && rollout.controlMode === "tool-driven" && (
        <div className="alert" role="note">
          <Icon of={CircleAlert} />
          <div>
            <b>Công cụ giao hàng tự phân tích và tự quyết</b>
            <div>
              UDP soi gương tiến độ của nó; bạn vẫn promote hay rollback tay
              được.
            </div>
          </div>
        </div>
      )}
      {split && !service && (
        <div className="alert" role="note">
          <Icon of={CircleAlert} />
          <div>
            <b>Chia theo thuộc tính: hệ thống không tự promote hay rollback</b>
            <div>
              Hai nhóm khác nhau về bản chất, nên chênh lệch dưới đây là số kỹ
              thuật, không quy được cho nhánh flag. Bạn quyết: đổi variant mặc
              định sang variant mới, hoặc rollback.
            </div>
          </div>
        </div>
      )}
      <WhyStill rollout={rollout} maxBreaches={maxBreaches} />

      <div className="stat">
        <div>
          <div className="l">
            {service
              ? "Lưu lượng phiên bản mới"
              : split
                ? "Nhóm khớp nhận variant mới"
                : "Lưu lượng variant mới"}
          </div>
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
          <div className="l">
            {service
              ? "Tỉ lệ lỗi phiên bản mới / cũ"
              : split
                ? "Tỉ lệ lỗi nhánh mới / nhánh cũ"
                : "Tỉ lệ lỗi canary / đối chứng"}
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
          <div className="l">Latency P99 canary</div>
          <div className="v num">
            {snap?.canary.latencyP99Ms === undefined
              ? "–"
              : `${formatNumber(Math.round(snap.canary.latencyP99Ms))}`}
            <small>ms</small>
          </div>
        </div>
      </div>

      <div className="steps">
        <div
          className={rollout.status === "FAILED" ? "seg2 fail" : "seg2"}
          role="progressbar"
          aria-label="Lưu lượng đã chuyển"
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
            Bậc <b>{formatPercent(rollout.stepPercent)}</b> mỗi{" "}
            {formatDuration(rollout.stepIntervalSeconds)}, đo lại mỗi{" "}
            {formatDuration(rollout.analysisIntervalSeconds)}
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
              {!split && snap.zScore !== null && (
                <p className="c3">z-score: {formatDecimal(snap.zScore)}</p>
              )}
            </details>
          )}
        </div>
        <div className="panel2">
          <h2 className="h2" style={{ marginTop: 10 }}>
            Nhật ký
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
  /*
   * Chỉ LÝ DO (đổi vài phút một lần) nằm trong vùng aria-live; hai đồng hồ đếm từng giây ở ngoài nó —
   * nếu không trình đọc màn hình đọc lại cả khối mỗi giây.
   */
  return (
    <div className="alert amber">
      <Icon of={CircleAlert} />
      <div>
        <div role="status" aria-live="polite">
          {rollout.pendingIntent !== undefined ? (
            <b>
              Đang thực hiện: {EVENT_LABEL[rollout.pendingIntent.action]} (yêu
              cầu bởi {rollout.pendingIntent.byUser || "một thành viên"})
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
        </div>
        {active && (
          <div className="c2 num">
            {nextAnalysis !== undefined && (
              <>Đo lại sau {formatDuration(nextAnalysis)}. </>
            )}
            Đủ thời gian giữ bậc sau {formatDuration(dwellLeft)}.
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
            ? "Đang thực hiện…"
            : labelOf(a, rollout)}
        </button>
      ))}
      {confirm !== null && (
        <ConfirmDialog
          title={
            confirm === "ROLLBACK"
              ? "Rollback rollout này?"
              : !service && rollout.strategy === "ATTRIBUTE_SPLIT"
                ? "Đổi variant mặc định?"
                : "Đưa lên 100%?"
          }
          description={
            service
              ? confirm === "ROLLBACK"
                ? `Công cụ giao hàng đưa toàn bộ traffic về phiên bản ${rollout.versionOld ?? "cũ"}.`
                : `Phiên bản ${rollout.versionNew ?? "mới"} nhận 100% traffic.`
              : confirm === "ROLLBACK"
                ? `Lưu lượng về lại mốc ${rollout.baselinePercentage === null ? "ban đầu" : formatPercent(rollout.baselinePercentage)}.`
                : rollout.strategy === "ATTRIBUTE_SPLIT"
                  ? "Mọi người dùng của environment, không riêng nhóm khớp, sẽ nhận variant mới làm mặc định. Rollout kết thúc."
                  : "Mọi người dùng khớp rule sẽ nhận variant mới."
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
 * Tỉ lệ lỗi canary so với đối chứng qua các lần đo có ghi snapshot, cùng ngưỡng (§10.13 "baseline +
 * đối chứng"; DESIGN.md §6 "Biểu đồ", "Trục biểu đồ"). Dùng `LineChart` chung: thang co theo dữ liệu,
 * nên canary 0,4% không còn nằm dẹt dưới đáy vì thang bị kéo tới ngưỡng 5%.
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
      at: new Date(e.createdAt).getTime(),
      canary:
        e.metricSnapshot === null
          ? null
          : e.metricSnapshot.canary.errorRate * 100,
      baseline:
        e.metricSnapshot === null
          ? null
          : e.metricSnapshot.baseline.errorRate * 100,
    }))
    .sort((a, b) => a.at - b.at);

  if (points.length === 0) {
    return (
      <div className="cardc">
        <div className="hd">
          <h2>Tỉ lệ lỗi</h2>
        </div>
        <p className="c3">Chưa có lần đo nào có số liệu.</p>
      </div>
    );
  }
  return (
    <div className="cardc">
      <LineChart
        title="Tỉ lệ lỗi"
        level={2}
        times={points.map((p) => p.at)}
        series={[
          {
            key: "canary",
            label: "canary",
            tone: "accent",
            values: points.map((p) => p.canary),
          },
          {
            key: "baseline",
            label: "đối chứng",
            tone: "baseline",
            values: points.map((p) => p.baseline),
          },
        ]}
        threshold={{
          value: limit * 100,
          label: `ngưỡng ${formatPercent(limit * 100)}`,
        }}
        format={formatPercent}
      />
    </div>
  );
}
