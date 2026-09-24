import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import type { PublicProjectWire } from "@udp/shared-types/wire";
import { CircleAlert, CircleCheck, FolderKanban, Plus } from "lucide-react";
import { Icon } from "../../components/Icon";
import { Empty, ErrorState, Loading } from "../../components/States";
import { relativeTime } from "../../lib/format";
import { qk } from "../../lib/query-keys";
import { projectApi } from "./project-api";
import { ROLE_LABEL } from "./roles";

/** Chữ cho trạng thái project — kèm icon, không chấm màu (DESIGN.md §5) */
export const PROJECT_STATUS: Record<
  PublicProjectWire["status"],
  { label: string; ok: boolean }
> = {
  DRAFT: { label: "Nháp", ok: false },
  PROVISIONING: { label: "Đang dựng hạ tầng", ok: false },
  ACTIVE: { label: "Ổn định", ok: true },
  ERROR: { label: "Cần xem", ok: false },
  DELETED: { label: "Đã xoá", ok: false },
};

export function ProjectStatus({
  status,
}: {
  status: PublicProjectWire["status"];
}) {
  const s = PROJECT_STATUS[status];
  return (
    <span className={s.ok ? "stt" : "stt warn"}>
      <Icon of={s.ok ? CircleCheck : CircleAlert} />
      {s.label}
    </span>
  );
}

export function ProjectsPage() {
  const projects = useQuery({
    queryKey: qk.projects(),
    queryFn: projectApi.list,
  });

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
        <div className="mhead">
          <span className="tile xl">
            <Icon of={FolderKanban} size={21} />
          </span>
          <div>
            <h1>Project</h1>
            <p>Mọi project mà bạn là thành viên.</p>
          </div>
        </div>
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
            <div className="lst" role="list">
              {projects.data.projects.map((p) => (
                <Link
                  key={p.id}
                  role="listitem"
                  to="/app/projects/$projectId"
                  params={{ projectId: p.id }}
                  search={{}}
                >
                  <span className="t" style={{ fontWeight: 500 }}>
                    {p.name}
                  </span>
                  <span className="chip soft">{ROLE_LABEL[p.myRole]}</span>
                  <span className="c3 mono">{p.languageRuntime}</span>
                  <span style={{ marginLeft: "auto" }}>
                    <ProjectStatus status={p.status} />
                  </span>
                  <span className="c3 num">{relativeTime(p.createdAt)}</span>
                </Link>
              ))}
            </div>
          )}
        </div>
      </div>
    </>
  );
}
