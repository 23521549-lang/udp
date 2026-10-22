import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import { Plus } from "lucide-react";
import { useEffect, useState } from "react";
import { Icon } from "../../components/Icon";
import { InfoTip } from "../../components/InfoTip";
import { Empty, ErrorState, Loading } from "../../components/States";
import { useMessages } from "../../i18n";
import { formatDateTime, formatPercent, relativeTime } from "../../lib/format";
import { qk } from "../../lib/query-keys";
import { ProjectBar } from "../project/ProjectBar";
import { useProjectContext } from "../project/ProjectLayout";
import { can } from "../project/roles";
import { rolesMessages } from "../project/roles.messages";
import { CreateRolloutDialog } from "./CreateRolloutDialog";
import { rolloutApi } from "./rollout-api";
import { RolloutStatusIcon } from "./rollout-status";
import { rolloutMessages } from "./rollout.messages";
import { PageHead } from "../../components/PageHead";

/** Danh sách rollout của env đang chọn (§10.9, query key có `envId`) */
export function RolloutsPage() {
  const m = useMessages(rolloutMessages);
  const roles = useMessages(rolesMessages);
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
        title={m.list.title}
        actions={
          canCreate && (
            <button
              type="button"
              className="btn pri"
              onClick={() => setCreating(true)}
            >
              <Icon of={Plus} />
              {m.list.create}
            </button>
          )
        }
      />
      <div className="scroll">
        <PageHead
          title={m.list.title}
          lead={
            <>
              {m.list.lead(env.name)}
              <InfoTip term="rollout" />
            </>
          }
        />
        {rollouts.isPending ? (
          <Loading />
        ) : rollouts.isError ? (
          <ErrorState
            error={rollouts.error}
            onRetry={() => void rollouts.refetch()}
          />
        ) : rollouts.data.rollouts.length === 0 ? (
          // [Plan #58 UX-17] Vì sao trống, cần gì trước, và một nút — cùng khuôn với trang Deploy và Nhóm
          <Empty title={m.list.empty(env.name)}>
            <div className="empty-body">
              <p>{m.list.emptyWhy}</p>
              <p>{m.list.emptyNeed}</p>
              {canCreate ? (
                <button
                  type="button"
                  className="btn pri"
                  onClick={() => setCreating(true)}
                >
                  {m.list.createFirst}
                </button>
              ) : (
                <p>{m.list.emptyRole(roles.role.MAINTAINER)}</p>
              )}
            </div>
          </Empty>
        ) : (
          <div role="list" aria-label={m.list.label}>
            {rollouts.data.rollouts.map((r) => (
              <div role="listitem" key={r.id}>
                <Link
                  className="row ro-row"
                  to="/app/projects/$projectId/rollouts/$rolloutId"
                  params={{ projectId: project.id, rolloutId: r.id }}
                  search={{ env: env.id }}
                >
                  <RolloutStatusIcon
                    status={r.status}
                    percent={r.currentTrafficPercentage}
                  />
                  <span className="t mono" translate="no">
                    {r.flagKey ?? r.workloadName ?? r.id.slice(0, 8)}
                  </span>
                  <span className="k">
                    {m.list.strategy[r.strategy]} · {m.list.scope[r.scope]}
                    {r.workloadName !== null ? ` · ${r.workloadName}` : ""}
                  </span>
                  <span>{m.status[r.status]}</span>
                  <span className="num">
                    {formatPercent(r.currentTrafficPercentage)}
                  </span>
                  {/* Cột 64px để trống; thời gian ở cột cuối — cùng lưới `.row` với danh sách flag */}
                  <span className="ro-gap" />
                  <span className="when" title={formatDateTime(r.updatedAt)}>
                    {relativeTime(r.updatedAt)}
                  </span>
                </Link>
              </div>
            ))}
          </div>
        )}
      </div>
      {creating && <CreateRolloutDialog onClose={() => setCreating(false)} />}
    </>
  );
}
