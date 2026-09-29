import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import type { PublicProjectWire } from "@udp/shared-types/wire";
import { Plus } from "lucide-react";
import { Icon } from "../../components/Icon";
import { Pager } from "../../components/Pager";
import { StatusLabel, type Tone } from "../../components/StatusLabel";
import { Empty, ErrorState, Loading } from "../../components/States";
import { formatDateTime, relativeTime } from "../../lib/format";
import { qk } from "../../lib/query-keys";
import { PROJECT_PAGE_SIZE, projectApi } from "./project-api";
import { ROLE_LABEL } from "./roles";
import { PageHead } from "../../components/PageHead";

/** Chữ và tone cho trạng thái project — icon kèm chữ, không chấm màu (DESIGN.md §5) */
export const PROJECT_STATUS: Record<
  PublicProjectWire["status"],
  { label: string; tone: Tone }
> = {
  DRAFT: { label: "Nháp", tone: "unknown" },
  PROVISIONING: { label: "Đang dựng hạ tầng", tone: "running" },
  ACTIVE: { label: "Ổn định", tone: "ok" },
  ERROR: { label: "Cần xem", tone: "error" },
  DELETED: { label: "Đã xoá", tone: "unknown" },
};

/**
 * Trạng thái project, kèm nhãn hết hạn khi TTL đã qua (§4.4 lớp 3): với `WARN` máy chủ chỉ
 * cảnh báo và KHÔNG xoá, nên nhãn này là nơi duy nhất người dùng thấy project đã quá hạn.
 */
export function ProjectStatus({
  status,
  expiresAt = null,
  now = Date.now(),
}: {
  status: PublicProjectWire["status"];
  expiresAt?: string | null;
  now?: number;
}) {
  const s = PROJECT_STATUS[status];
  const expired =
    expiresAt !== null &&
    status !== "DELETED" &&
    new Date(expiresAt).getTime() <= now;
  return (
    <>
      <StatusLabel tone={s.tone}>{s.label}</StatusLabel>
      {expired && <span className="chip soft">Hết hạn</span>}
    </>
  );
}

export function ProjectsPage() {
  const offset = useSearch({ from: "/app/projects" }).offset ?? 0;
  const navigate = useNavigate();
  const setOffset = (n: number): void => {
    void navigate({
      to: "/app/projects",
      search: n === 0 ? {} : { offset: n },
    });
  };
  const projects = useQuery({
    queryKey: qk.projects(offset),
    queryFn: () => projectApi.list(offset),
    placeholderData: keepPreviousData,
  });
  const total = projects.data?.total ?? 0;

  return (
    <>
      <div className="bar">
        <div className="crumbs">
          <b>Project</b>
        </div>
        <div className="r">
          <Link to="/app/projects/new" className="btn pri">
            <Icon of={Plus} />
            Tạo project
          </Link>
        </div>
      </div>
      <div className="scroll">
        <PageHead title="Project" lead="Mọi project mà bạn là thành viên." />
        <div className="page">
          {projects.isPending ? (
            <Loading />
          ) : projects.isError ? (
            <ErrorState
              error={projects.error}
              onRetry={() => void projects.refetch()}
            />
          ) : projects.data.projects.length === 0 ? (
            <Empty title="Chưa có project nào">
              <Link to="/app/projects/new" className="btn pri">
                Tạo project đầu tiên
              </Link>
            </Empty>
          ) : (
            <div className="lst" role="list" aria-label="Project của bạn">
              {projects.data.projects.map((p) => (
                <div role="listitem" key={p.id}>
                  <Link
                    to="/app/projects/$projectId"
                    params={{ projectId: p.id }}
                    search={{}}
                  >
                    <span className="t lst-name" translate="no">
                      {p.name}
                    </span>
                    <span className="chip soft">{ROLE_LABEL[p.myRole]}</span>
                    <span className="c3 mono">{p.languageRuntime}</span>
                    <span className="lst-end">
                      <ProjectStatus
                        status={p.status}
                        expiresAt={p.expiresAt}
                      />
                    </span>
                    <span
                      className="c3 num"
                      title={formatDateTime(p.createdAt)}
                    >
                      {relativeTime(p.createdAt)}
                    </span>
                  </Link>
                </div>
              ))}
            </div>
          )}
          <Pager
            label="Trang của danh sách project"
            offset={offset}
            pageSize={PROJECT_PAGE_SIZE}
            total={total}
            onChange={setOffset}
          />
        </div>
      </div>
    </>
  );
}
