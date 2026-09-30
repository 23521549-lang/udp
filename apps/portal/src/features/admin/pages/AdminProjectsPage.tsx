import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import { Search } from "lucide-react";
import { useCallback } from "react";
import { Icon } from "../../../components/Icon";
import { Pager } from "../../../components/Pager";
import { Empty, ErrorState, Loading } from "../../../components/States";
import { useMessages } from "../../../i18n";
import { formatDateTime, formatNumber } from "../../../lib/format";
import { qk } from "../../../lib/query-keys";
import { useSearchInput } from "../../../lib/use-search-input";
import { PROVIDER_LABEL } from "../../project/cloud/cloud-labels";
import { projectStatusMessages } from "../../project/project-status.messages";
import { ProjectStatus } from "../../project/ProjectStatus";
import { ADMIN_PAGE_SIZE, adminApi, filterKey } from "../admin-api";
import {
  ADMIN_PROJECT_STATUSES,
  CREATED_DEFAULT,
  CREATED_SORTS,
  setParam,
} from "../admin-search";
import { adminMessages } from "../admin.messages";
import { AdminPage } from "../AdminLayout";
import { useProjectPeek } from "../ProjectPeek";
import { SortHeader } from "../SortHeader";
import { parseSort, sortParam, toggleSort } from "../sort";

/**
 * Mọi project (§10.11). Bộ lọc và trang trên URL (Plan #53 QĐ-9).
 *
 * [Plan #58 UX-34] Tìm theo tên hoặc email chủ (`?q=`), sắp theo ngày tạo, trạng thái đứng ngay sau tên (vẫn thấy trên
 * điện thoại); tên mở panel của project. Tổng không lọc gồm cả project đã xoá và nói rõ điều đó (UX-8).
 */
export function AdminProjectsPage() {
  const statusLabel = useMessages(projectStatusMessages).status;
  const t = useMessages(adminMessages);
  const m = t.projects;
  const search = useSearch({ from: "/admin/projects" });
  const navigate = useNavigate({ from: "/admin/projects" });
  const term = (search.q ?? "").trim();
  const offset = search.offset ?? 0;
  const sort = parseSort(search.sort, CREATED_SORTS) ?? CREATED_DEFAULT;
  const filter = {
    status: search.status,
    search: term === "" ? undefined : term,
    order: sort.dir === "asc" ? ("asc" as const) : undefined,
  };
  const filtered = filter.status !== undefined || filter.search !== undefined;
  const projects = useQuery({
    queryKey: qk.adminProjects(filterKey(filter), offset),
    queryFn: () => adminApi.projects(filter, offset),
    placeholderData: keepPreviousData,
  });
  // Tổng quan đếm project CHƯA xoá: hiệu hai con số là số đã xoá nằm trong tổng của trang này
  const overview = useQuery({
    queryKey: qk.adminOverview(),
    queryFn: adminApi.overview,
  });
  const commitTerm = useCallback(
    (next: string) => {
      void navigate({
        replace: true,
        search: (prev) =>
          setParam(
            setParam(prev, "offset", undefined),
            "q",
            next === "" ? undefined : next,
          ),
      });
    },
    [navigate],
  );
  const [q, setQ] = useSearchInput(term, commitTerm);
  const setOffset = (n: number): void => {
    void navigate({
      search: (prev) => setParam(prev, "offset", n === 0 ? undefined : n),
    });
  };
  const setProject = (id: string | undefined): void => {
    void navigate({
      search: (prev) => setParam(prev, "project", id),
      resetScroll: false,
    });
  };
  const peek = useProjectPeek(search.project, setProject);
  const onSort = (): void => {
    const next = toggleSort(sort, "created", "desc");
    void navigate({
      search: (prev) =>
        setParam(
          setParam(prev, "offset", undefined),
          "sort",
          sortParam(next, CREATED_DEFAULT),
        ),
      replace: true,
    });
  };
  const total = projects.data?.total;
  const live = overview.data?.overview.projects.total;
  const deleted =
    !filtered && total !== undefined && live !== undefined ? total - live : 0;

  return (
    <AdminPage
      title={m.title}
      lead={m.lead}
      minis={
        total === undefined
          ? undefined
          : [
              {
                value: total,
                label:
                  deleted > 0
                    ? m.countWithDeleted(total, deleted)
                    : m.count(total),
              },
            ]
      }
      peek={peek}
    >
      <div className="filters flush">
        <label className="q">
          <Icon of={Search} />
          <input
            type="search"
            name="q"
            aria-label={m.search}
            placeholder={m.searchPlaceholder}
            autoComplete="off"
            spellCheck={false}
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
        </label>
        <select
          className="sel"
          name="status"
          aria-label={m.statusFilter}
          value={search.status ?? ""}
          onChange={(e) =>
            void navigate({
              search: (prev) =>
                setParam(
                  setParam(prev, "offset", undefined),
                  "status",
                  ADMIN_PROJECT_STATUSES.find((s) => s === e.target.value),
                ),
            })
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
        filtered ? (
          <Empty title={m.noMatch}>
            <button
              type="button"
              className="btn"
              onClick={() => {
                setQ("");
                void navigate({ search: {} });
              }}
            >
              {t.clearFilters}
            </button>
          </Empty>
        ) : (
          <Empty title={m.empty} />
        )
      ) : (
        <div className="table-wrap">
          <table className="dtable" aria-label={m.table}>
            <thead>
              <tr>
                <th scope="col">{m.name}</th>
                <th scope="col">{m.status}</th>
                <th scope="col">{t.owner}</th>
                <th scope="col">{t.cloud}</th>
                <th scope="col" className="num">
                  {m.members}
                </th>
                <SortHeader
                  label={t.created}
                  column="created"
                  sort={sort}
                  onSort={onSort}
                />
              </tr>
            </thead>
            <tbody>
              {projects.data.projects.map((p) => (
                <tr
                  key={p.id}
                  className={p.id === search.project ? "on" : undefined}
                >
                  <th scope="row">
                    <Link
                      to="/admin/projects"
                      search={setParam(search, "project", p.id)}
                      resetScroll={false}
                      translate="no"
                    >
                      {p.name}
                    </Link>
                  </th>
                  <td>
                    <ProjectStatus status={p.status} />
                  </td>
                  <td translate="no">{p.owner.email}</td>
                  <td>
                    {p.cloudProvider === null
                      ? m.notConnected
                      : PROVIDER_LABEL[p.cloudProvider]}
                  </td>
                  <td className="num">{formatNumber(p.memberCount)}</td>
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
        total={total ?? 0}
        onChange={setOffset}
      />
    </AdminPage>
  );
}
