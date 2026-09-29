import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { Pager } from "../../../components/Pager";
import { Empty, ErrorState, Loading } from "../../../components/States";
import { StatusLabel } from "../../../components/StatusLabel";
import { useMessages } from "../../../i18n";
import { formatDateTime, relativeTime } from "../../../lib/format";
import { qk } from "../../../lib/query-keys";
import {
  jobStateLabel,
  jobTypeLabel,
} from "../../provisioning/provisioning-labels";
import { ADMIN_PAGE_SIZE, adminApi } from "../admin-api";
import { adminMessages } from "../admin.messages";
import { AdminPage } from "../AdminLayout";

export const ADMIN_JOB_STATES = [
  "FAILED",
  "COMPENSATION_FAILED",
  "CANCEL_REQUESTED",
] as const;
export type AdminJobState = (typeof ADMIN_JOB_STATES)[number];
export const DEFAULT_ADMIN_JOB_STATE: AdminJobState = "FAILED";

/**
 * Lỗi của job đọc được: `lastError` của worker là `{step, message, orphans}` (§8.1). Dạng khác — job
 * cũ hơn khuôn đó — rơi về JSON trong khối "Chi tiết kỹ thuật", không bao giờ mất.
 */
export function readableJobError(
  lastError: unknown,
): { step: string; message: string; orphans: number } | null {
  if (typeof lastError !== "object" || lastError === null) return null;
  const e = lastError as Record<string, unknown>;
  if (typeof e.message !== "string") return null;
  return {
    step: typeof e.step === "string" ? e.step : "",
    message: e.message,
    orphans: Array.isArray(e.orphans) ? e.orphans.length : 0,
  };
}

/** Job hỏng hoặc kẹt trên toàn hệ thống (§10.11). Trạng thái và trang trên URL (Plan #53 QĐ-9) */
export function AdminJobsPage() {
  const m = useMessages(adminMessages).jobs;
  const search = useSearch({ from: "/admin/jobs" });
  const navigate = useNavigate({ from: "/admin/jobs" });
  const state = search.state ?? DEFAULT_ADMIN_JOB_STATE;
  const offset = search.offset ?? 0;
  const jobs = useQuery({
    queryKey: qk.adminJobs(state, offset),
    queryFn: () => adminApi.jobs(state, offset),
    placeholderData: keepPreviousData,
  });
  const setState = (next: AdminJobState): void => {
    void navigate({
      search: next === DEFAULT_ADMIN_JOB_STATE ? {} : { state: next },
    });
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
        jobs.data === undefined
          ? undefined
          : [
              {
                value: jobs.data.total,
                label: jobStateLabel(state).toLowerCase(),
              },
            ]
      }
    >
      <div className="filters flush">
        <div className="seg" role="group" aria-label={m.stateFilter}>
          {ADMIN_JOB_STATES.map((s) => (
            <button
              key={s}
              type="button"
              aria-pressed={state === s}
              onClick={() => setState(s)}
            >
              {jobStateLabel(s)}
            </button>
          ))}
        </div>
      </div>
      {jobs.isPending ? (
        <Loading />
      ) : jobs.isError ? (
        <ErrorState error={jobs.error} onRetry={() => void jobs.refetch()} />
      ) : jobs.data.jobs.length === 0 ? (
        <Empty title={m.empty(jobStateLabel(state))} />
      ) : (
        <ul className="lst job-list" aria-label={m.list}>
          {jobs.data.jobs.map((j) => {
            const err = readableJobError(j.lastError);
            return (
              <li key={j.id} className="it job-it">
                <div className="job-h">
                  <b translate="no">{j.project.name}</b>
                  <span>{jobTypeLabel(j.jobType)}</span>
                  <StatusLabel
                    tone={state === "CANCEL_REQUESTED" ? "running" : "error"}
                  >
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
                {err !== null && (
                  <p className="job-err">
                    {err.step !== "" &&
                      m.step(
                        <span className="mono" translate="no">
                          {err.step}
                        </span>,
                      )}
                    {err.message}
                    {err.orphans > 0 && ` ${m.leftover(err.orphans)}`}
                  </p>
                )}
                {j.lastError !== null && (
                  <details className="job-raw">
                    <summary>{m.details}</summary>
                    <pre className="mono">
                      {JSON.stringify(j.lastError, null, 2)}
                    </pre>
                  </details>
                )}
              </li>
            );
          })}
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
