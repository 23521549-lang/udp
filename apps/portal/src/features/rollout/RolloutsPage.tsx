import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import { ChartNoAxesColumnIncreasing, Plus } from "lucide-react";
import { useEffect, useState } from "react";
import { Icon } from "../../components/Icon";
import { Empty, ErrorState, Loading } from "../../components/States";
import { formatPercent, relativeTime } from "../../lib/format";
import { qk } from "../../lib/query-keys";
import { ProjectBar } from "../project/ProjectBar";
import { useProjectContext } from "../project/ProjectLayout";
import { can } from "../project/roles";
import { CreateRolloutDialog } from "./CreateRolloutDialog";
import { rolloutApi } from "./rollout-api";
import { RolloutStatusIcon, ROLLOUT_STATUS_LABEL } from "./rollout-status";

const STRATEGY_LABEL = {
  CANARY: "Canary",
  ATTRIBUTE_SPLIT: "Chia theo thuộc tính",
  BLUE_GREEN: "Blue-Green",
} as const;

/** Danh sách rollout của env đang chọn (§10.9, query key có `envId`) */
export function RolloutsPage() {
  const { project, env } = useProjectContext();
  const search = useSearch({ from: "/app/projects/$projectId/rollouts" });
  const navigate = useNavigate();
  const [creating, setCreating] = useState(false);
  // `?new=1` (từ bảng lệnh): mở hộp tạo một lần rồi bỏ tham số, để Back không mở lại
  useEffect(() => {
    if (search.new !== "1") return;
    setCreating(true);
    void navigate({
      to: ".",
      replace: true,
      search: (prev: Record<string, unknown>) => {
        const { new: _drop, ...rest } = prev;
        return rest;
      },
    });
  }, [search.new, navigate]);
  const rollouts = useQuery({
    queryKey: qk.rollouts(project.id, env.id),
    queryFn: () => rolloutApi.list(project.id, env.id),
    refetchInterval: (q) =>
      q.state.data?.rollouts.some(
        (r) => r.status === "IN_PROGRESS" || r.status === "PENDING",
      )
        ? 15_000
        : false,
  });
  const canCreate = can(project.myRole, "MAINTAINER");

  return (
    <>
      <ProjectBar
        title="Rollout"
        actions={
          canCreate && (
            <button
              type="button"
              className="btn pri"
              onClick={() => setCreating(true)}
            >
              <Icon of={Plus} />
              Tạo rollout
            </button>
          )
        }
      />
      <div className="scroll">
        <div className="mhead">
          <span className="tile xl">
            <Icon of={ChartNoAxesColumnIncreasing} size={21} />
          </span>
          <div>
            <h1>Rollout</h1>
            <p>
              Tăng dần một variant, tự rollback khi metric vượt ngưỡng. Đang xem{" "}
              {env.name}.
            </p>
          </div>
        </div>
        {rollouts.isPending ? (
          <Loading />
        ) : rollouts.isError ? (
          <ErrorState
            error={rollouts.error}
            onRetry={() => void rollouts.refetch()}
          />
        ) : rollouts.data.rollouts.length === 0 ? (
          <Empty title={`Chưa có rollout nào ở ${env.name}`} />
        ) : (
          <div role="list" aria-label="Danh sách rollout">
            {rollouts.data.rollouts.map((r) => (
              <Link
                key={r.id}
                role="listitem"
                className="row ro-row"
                to="/app/projects/$projectId/rollouts/$rolloutId"
                params={{ projectId: project.id, rolloutId: r.id }}
                search={{ env: env.id }}
              >
                <RolloutStatusIcon
                  status={r.status}
                  percent={r.currentTrafficPercentage}
                />
                <span className="t mono">
                  {r.flagKey ?? r.workloadName ?? r.id.slice(0, 8)}
                </span>
                <span className="k">
                  {STRATEGY_LABEL[r.strategy]} ·{" "}
                  {r.scope === "FLAG_LEVEL" ? "theo flag" : "theo phiên bản"}
                  {r.workloadName !== null ? ` · ${r.workloadName}` : ""}
                </span>
                <span>{ROLLOUT_STATUS_LABEL[r.status]}</span>
                <span className="num">
                  {formatPercent(r.currentTrafficPercentage)}
                </span>
                <span className="when">{relativeTime(r.updatedAt)}</span>
                <span />
              </Link>
            ))}
          </div>
        )}
      </div>
      {creating && <CreateRolloutDialog onClose={() => setCreating(false)} />}
    </>
  );
}
