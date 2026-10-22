import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import { Plus } from "lucide-react";
import { Icon } from "../../components/Icon";
import { Pager } from "../../components/Pager";
import { ErrorState, Loading } from "../../components/States";
import { formatDateTime, relativeTime } from "../../lib/format";
import { qk } from "../../lib/query-keys";
import { FirstRun } from "../home/FirstRun";
import { useAttentionByProject } from "../home/home-api";
import { PROJECT_PAGE_SIZE, projectApi } from "./project-api";
import { ProjectHealth, ProjectStatus } from "./ProjectStatus";
import { rolesMessages } from "./roles.messages";
import { useMessages } from "../../i18n";
import { PageHead } from "../../components/PageHead";
import { projectMessages } from "./project.messages";

export function ProjectsPage() {
  const roles = useMessages(rolesMessages).role;
  const m = useMessages(projectMessages);
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
  const attention = useAttentionByProject();

  return (
    <>
      <div className="bar">
        <div className="crumbs">
          <b>{m.projects}</b>
        </div>
        <div className="r">
          <Link to="/app/projects/new" className="btn pri">
            <Icon of={Plus} />
            {m.createProject}
          </Link>
        </div>
      </div>
      <div className="scroll">
        <PageHead title={m.projects} lead={m.list.lead} />
        <div className="page">
          {projects.isPending ? (
            <Loading />
          ) : projects.isError ? (
            <ErrorState
              error={projects.error}
              onRetry={() => void projects.refetch()}
            />
          ) : projects.data.total === 0 ? (
            <FirstRun />
          ) : (
            <div className="lst" role="list" aria-label={m.list.label}>
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
                      <ProjectHealth attention={attention?.get(p.id)} />
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
            label={m.list.pages}
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
