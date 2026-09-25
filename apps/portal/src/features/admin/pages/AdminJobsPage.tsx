import { useQuery } from "@tanstack/react-query";
import { ListX } from "lucide-react";
import { useState } from "react";
import { Empty, ErrorState, Loading } from "../../../components/States";
import { formatDateTime } from "../../../lib/format";
import { qk } from "../../../lib/query-keys";
import { adminApi } from "../admin-api";

import { AdminPage } from "../AdminLayout";
export function AdminJobsPage() {
  const [state, setState] = useState("FAILED");
  const jobs = useQuery({
    queryKey: qk.adminJobs(state),
    queryFn: () => adminApi.jobs(state),
  });
  return (
    <AdminPage
      title="Job provisioning"
      lead="Job hỏng hoặc kẹt trên toàn hệ thống."
      icon={ListX}
    >
      <div className="filters" style={{ padding: "0 0 10px" }}>
        <div className="seg" role="group" aria-label="Trạng thái job">
          {["FAILED", "COMPENSATION_FAILED", "CANCEL_REQUESTED"].map((s) => (
            <button
              key={s}
              type="button"
              aria-pressed={state === s}
              onClick={() => setState(s)}
            >
              {s}
            </button>
          ))}
        </div>
      </div>
      {jobs.isPending ? (
        <Loading />
      ) : jobs.isError ? (
        <ErrorState error={jobs.error} onRetry={() => void jobs.refetch()} />
      ) : jobs.data.jobs.length === 0 ? (
        <Empty title="Không có job nào ở trạng thái này" />
      ) : (
        <div className="lst">
          {jobs.data.jobs.map((j) => (
            <div key={j.id} className="it" style={{ flexWrap: "wrap" }}>
              <b style={{ fontWeight: 500 }}>{j.project.name}</b>
              <span className="mono c3">{j.jobType}</span>
              <span className="c3">lần {j.attempt}</span>
              <span className="c3" style={{ marginLeft: "auto" }}>
                {formatDateTime(j.updatedAt)}
              </span>
              {j.lastError !== null && (
                <pre className="mono diff" style={{ margin: 0 }}>
                  {JSON.stringify(j.lastError, null, 2)}
                </pre>
              )}
            </div>
          ))}
        </div>
      )}
    </AdminPage>
  );
}
