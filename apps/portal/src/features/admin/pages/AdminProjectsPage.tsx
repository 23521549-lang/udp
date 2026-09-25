import { useQuery } from "@tanstack/react-query";
import { FolderKanban } from "lucide-react";
import { useState } from "react";
import { Empty, ErrorState, Loading } from "../../../components/States";
import { formatDateTime } from "../../../lib/format";
import { qk } from "../../../lib/query-keys";
import { PROJECT_STATUS } from "../../project/ProjectsPage";
import { adminApi } from "../admin-api";

import { AdminPage } from "../AdminLayout";
const STATUSES = [
  "",
  "DRAFT",
  "PROVISIONING",
  "ACTIVE",
  "ERROR",
  "DELETED",
] as const;

export function AdminProjectsPage() {
  const [status, setStatus] = useState<(typeof STATUSES)[number]>("");
  const projects = useQuery({
    queryKey: qk.adminProjects(status),
    queryFn: () => adminApi.projects(status === "" ? undefined : status),
  });
  return (
    <AdminPage
      title="Project"
      lead="Mọi project trên nền tảng, kể cả đã xoá mềm."
      icon={FolderKanban}
    >
      <div className="filters" style={{ padding: "0 0 10px" }}>
        <select
          className="sel"
          aria-label="Lọc theo trạng thái"
          value={status}
          onChange={(e) =>
            setStatus(e.target.value as (typeof STATUSES)[number])
          }
        >
          {STATUSES.map((s) => (
            <option key={s} value={s}>
              {s === "" ? "Mọi trạng thái" : PROJECT_STATUS[s].label}
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
        <Empty title="Không có project nào" />
      ) : (
        <div className="table-wrap">
          <table className="matrix" aria-label="Project">
            <thead>
              <tr>
                <th scope="col">Tên</th>
                <th scope="col">Chủ</th>
                <th scope="col">Trạng thái</th>
                <th scope="col">Cloud</th>
                <th scope="col">Thành viên</th>
                <th scope="col">Tạo lúc</th>
              </tr>
            </thead>
            <tbody>
              {projects.data.projects.map((p) => (
                <tr key={p.id}>
                  <th scope="row">{p.name}</th>
                  <td>{p.owner.email}</td>
                  <td>{PROJECT_STATUS[p.status].label}</td>
                  <td>{p.cloudProvider ?? "–"}</td>
                  <td className="num">{p.memberCount}</td>
                  <td>{formatDateTime(p.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </AdminPage>
  );
}
