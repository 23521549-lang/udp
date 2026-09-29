import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { Pager } from "../../../components/Pager";
import { Empty, ErrorState, Loading } from "../../../components/States";
import { formatDateTime } from "../../../lib/format";
import { qk } from "../../../lib/query-keys";
import { PROVIDER_LABEL } from "../../project/cloud/cloud-labels";
import { useMessages } from "../../../i18n";
import { projectStatusMessages } from "../../project/project-status.messages";
import { adminMessages } from "../admin.messages";
import { ProjectStatus } from "../../project/ProjectStatus";
import { ADMIN_PAGE_SIZE, adminApi } from "../admin-api";
import { AdminPage } from "../AdminLayout";

export const ADMIN_PROJECT_STATUSES = [
  "DRAFT",
  "PROVISIONING",
  "ACTIVE",
  "ERROR",
  "DELETED",
] as const;
export type AdminProjectStatus = (typeof ADMIN_PROJECT_STATUSES)[number];

/** Mọi project (§10.11). Bộ lọc và trang trên URL (Plan #53 QĐ-9) */
export function AdminProjectsPage() {
  const statusLabel = useMessages(projectStatusMessages).status;
  const t = useMessages(adminMessages);
  const m = t.projects;
  const search = useSearch({ from: "/admin/projects" });
  const navigate = useNavigate({ from: "/admin/projects" });
  const status = search.status;
  const offset = search.offset ?? 0;
  const projects = useQuery({
    queryKey: qk.adminProjects(status ?? "", offset),
    queryFn: () => adminApi.projects(status, offset),
    placeholderData: keepPreviousData,
  });
  const setStatus = (next: AdminProjectStatus | undefined): void => {
    void navigate({ search: next === undefined ? {} : { status: next } });
  };
  const setOffset = (n: number): void => {
    void navigate({
      search: (prev) => {
        const { offset: _o, ...rest } = prev;
        return n === 0 ? rest : { ...rest, offset: n };
      },
    });
  };

  return (
    <AdminPage
      title={m.title}
      lead={m.lead}
      minis={
        projects.data === undefined
          ? undefined
          : [
              {
                value: projects.data.total,
                label: m.count(projects.data.total),
              },
            ]
      }
    >
      <div className="filters flush">
        <select
          className="sel"
          name="status"
          aria-label={m.statusFilter}
          value={status ?? ""}
          onChange={(e) =>
            setStatus(ADMIN_PROJECT_STATUSES.find((s) => s === e.target.value))
          }
        >
          <option value="">{m.allStatuses}</option>
          {ADMIN_PROJECT_STATUSES.map((s) => (
            <option key={s} value={s}>
              {statusLabel[s]}
            </option>
          ))}
        </select>
      </div>
      {projects.isPending ? (
        <Loading />
      ) : projects.isError ? (
        <ErrorState
          error={projects.error}
          onRetry={() => void projects.refetch()}
        />
      ) : projects.data.projects.length === 0 ? (
        <Empty title={m.empty} />
      ) : (
        <div className="table-wrap">
          <table className="dtable" aria-label={m.table}>
            <thead>
              <tr>
                <th scope="col">{m.name}</th>
                <th scope="col">{m.owner}</th>
                <th scope="col">{m.status}</th>
                <th scope="col">{t.cloud}</th>
                <th scope="col" className="num">
                  {m.members}
                </th>
                <th scope="col">{t.created}</th>
              </tr>
            </thead>
            <tbody>
              {projects.data.projects.map((p) => (
                <tr key={p.id}>
                  <th scope="row" translate="no">
                    {p.name}
                  </th>
                  <td translate="no">{p.owner.email}</td>
                  <td>
                    <ProjectStatus status={p.status} />
                  </td>
                  <td>
                    {p.cloudProvider === null
                      ? m.notConnected
                      : PROVIDER_LABEL[p.cloudProvider]}
                  </td>
                  <td className="num">{p.memberCount}</td>
                  <td className="num">{formatDateTime(p.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <Pager
        label={m.pager}
        offset={offset}
        pageSize={ADMIN_PAGE_SIZE}
        total={projects.data?.total ?? 0}
        onChange={setOffset}
      />
    </AdminPage>
  );
}
