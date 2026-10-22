import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import { InfoTip } from "../../../components/InfoTip";
import { Pager } from "../../../components/Pager";
import { Empty, ErrorState, Loading } from "../../../components/States";
import { StatusLabel } from "../../../components/StatusLabel";
import { useMessages } from "../../../i18n";
import {
  formatDateTime,
  formatNumber,
  relativeTime,
} from "../../../lib/format";
import { qk } from "../../../lib/query-keys";
import {
  jobStateLabel,
  jobTypeLabel,
} from "../../provisioning/provisioning-labels";
import { ADMIN_PAGE_SIZE, adminApi } from "../admin-api";
import {
  ADMIN_JOB_STATES,
  defaultJobState,
  jobCounts,
  setParam,
  type AdminJobState,
} from "../admin-search";
import { adminMessages } from "../admin.messages";
import { AdminPage } from "../AdminLayout";
import { JobErrorText, jobStateTone } from "../job-error";
import { useProjectPeek } from "../ProjectPeek";

/**
 * Job hỏng hoặc kẹt trên toàn hệ thống (§10.11). Trạng thái và trang trên URL (Plan #53 QĐ-9).
 *
 * [Plan #58 UX-28] Mỗi tab mang số của nó (từ Tổng quan, đã có trong cache của khung); "Dọn chưa hết" đứng đầu và là
 * tab mặc định khi còn job như thế, vì tài nguyên còn lại có thể đang tốn tiền của khách. Tên project mở panel của nó.
 */
export function AdminJobsPage() {
  const t = useMessages(adminMessages);
  const m = t.jobs;
  const search = useSearch({ from: "/admin/jobs" });
  const navigate = useNavigate({ from: "/admin/jobs" });
  const overview = useQuery({
    queryKey: qk.adminOverview(),
    queryFn: adminApi.overview,
  });
  const counts =
    overview.data === undefined ? undefined : jobCounts(overview.data.overview);
  // Tab mặc định tuỳ số liệu: chờ Tổng quan trả lời thay vì tải một tab rồi nhảy sang tab khác
  const state: AdminJobState | undefined =
    search.state ?? (overview.isPending ? undefined : defaultJobState(counts));
  const offset = search.offset ?? 0;
  const jobs = useQuery({
    queryKey: qk.adminJobs(state ?? "", offset),
    queryFn: () => adminApi.jobs(state ?? defaultJobState(counts), offset),
    enabled: state !== undefined,
    placeholderData: keepPreviousData,
  });
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

  return (
    <AdminPage
      title={m.title}
      lead={
        <>
          {m.lead}
          <InfoTip term="provisioning" />
        </>
      }
      minis={
        jobs.data === undefined || state === undefined
          ? undefined
          : [
              {
                value: jobs.data.total,
                label: jobStateLabel(state).toLowerCase(),
              },
            ]
      }
      peek={peek}
    >
      <div className="filters flush">
        <div className="seg" role="group" aria-label={m.stateFilter}>
          {ADMIN_JOB_STATES.map((s) => (
            <button
              key={s}
              type="button"
              aria-pressed={state === s}
              onClick={() => void navigate({ search: { state: s } })}
            >
              {jobStateLabel(s)}
              {counts !== undefined && " "}
              {counts !== undefined && (
                <span
                  className={
                    s === "COMPENSATION_FAILED" && counts[s] > 0
                      ? "seg-n hot"
                      : "seg-n"
                  }
                >
                  {formatNumber(counts[s])}
                </span>
              )}
            </button>
          ))}
        </div>
      </div>
      {jobs.isPending ? (
        <Loading />
      ) : jobs.isError ? (
        <ErrorState error={jobs.error} onRetry={() => void jobs.refetch()} />
      ) : jobs.data.jobs.length === 0 ? (
        <Empty title={m.empty} />
      ) : (
        <ul className="lst job-list" aria-label={m.list}>
          {jobs.data.jobs.map((j) => (
            <li
              key={j.id}
              className={
                j.project.id === search.project ? "it job-it on" : "it job-it"
              }
            >
              <div className="job-h">
                <Link
                  to="/admin/jobs"
                  search={setParam(search, "project", j.project.id)}
                  resetScroll={false}
                  className="job-p"
                  translate="no"
                >
                  {j.project.name}
                </Link>
                <span>{jobTypeLabel(j.jobType)}</span>
                <StatusLabel tone={jobStateTone(j.state)}>
                  {jobStateLabel(j.state)}
                </StatusLabel>
                <span className="c3">{m.attempt(j.attempt)}</span>
                <span
                  className="c3 num lst-end"
                  title={formatDateTime(j.updatedAt)}
                >
                  {relativeTime(j.updatedAt)}
                </span>
              </div>
              <JobErrorText lastError={j.lastError} />
              {j.lastError !== null && (
                <details className="job-raw">
                  <summary>{m.details}</summary>
                  <pre className="mono">
                    {JSON.stringify(j.lastError, null, 2)}
                  </pre>
                </details>
              )}
            </li>
          ))}
        </ul>
      )}
      <Pager
        label={m.pager}
        offset={offset}
        pageSize={ADMIN_PAGE_SIZE}
        total={jobs.data?.total ?? 0}
        onChange={setOffset}
      />
    </AdminPage>
  );
}
