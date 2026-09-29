import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import { Plus } from "lucide-react";
import { Icon } from "../../components/Icon";
import { Pager } from "../../components/Pager";
import { Empty, ErrorState, Loading } from "../../components/States";
import { formatDateTime, relativeTime } from "../../lib/format";
import { qk } from "../../lib/query-keys";
import { PROJECT_PAGE_SIZE, projectApi } from "./project-api";
import { ProjectStatus } from "./ProjectStatus";
import { rolesMessages } from "./roles.messages";
import { useMessages } from "../../i18n";
import { PageHead } from "../../components/PageHead";

export function ProjectsPage() {
  const roles = useMessages(rolesMessages).role;
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
                    <span className="chip soft">{roles[p.myRole]}</span>
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
