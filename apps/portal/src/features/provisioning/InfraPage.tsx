import { useQuery } from "@tanstack/react-query";
import type { ProvisioningJobWire } from "@udp/shared-types/wire";

import { useState } from "react";
import { ErrorState, Loading } from "../../components/States";
import { useMessages } from "../../i18n";
import { formatDateTime } from "../../lib/format";
import { qk } from "../../lib/query-keys";
import { ProjectBar } from "../project/ProjectBar";
import { useProjectContext } from "../project/ProjectLayout";
import { can } from "../project/roles";
import { CostPanel } from "./CostPanel";
import { JobLog } from "./JobLog";
import { PreviewPanel } from "./PreviewPanel";
import { provisioningApi } from "./provisioning-api";
import { provisioningMessages } from "./provisioning.messages";
import { jobStateLabel, TERMINAL_STATES } from "./provisioning-labels";
import { PageHead } from "../../components/PageHead";

/** Project còn chạy lại được: nháp, hay lỗi sau khi đã dọn (§8.1) */
const STARTABLE = ["DRAFT", "ERROR"];

/**
 * Trang Hạ tầng của project (§10.5 bước 4–5 ngoài wizard): xem trước và triển khai khi
 * project còn nháp hay lỗi, tiến độ của lượt đang chạy, và lịch sử các lượt.
 */
export function InfraPage() {
  const { project } = useProjectContext();
  const m = useMessages(provisioningMessages).infra;
  const [picked, setPicked] = useState<string | null>(null);
  const jobs = useQuery({
    queryKey: qk.jobs(project.id),
    queryFn: () => provisioningApi.jobs(project.id),
  });

  const list = jobs.data?.jobs ?? [];
  const running = list.find((j) => !TERMINAL_STATES.includes(j.state));
  const shown = picked ?? running?.id ?? list[0]?.id ?? null;
  const canStart = STARTABLE.includes(project.status) && running === undefined;

  return (
    <>
      <ProjectBar title={m.title} envScoped={false} />
      <div className="scroll">
        <PageHead title={m.title} lead={m.lead} />
        <div className="page">
          {jobs.isPending && <Loading />}
          {jobs.isError && (
            <ErrorState
              error={jobs.error}
              onRetry={() => void jobs.refetch()}
            />
          )}
          {jobs.isSuccess && canStart && (
            <PreviewPanel
              projectId={project.id}
              role={project.myRole}
              onStarted={(job) => setPicked(job.id)}
            />
          )}
          {shown !== null && (
            <JobLog
              projectId={project.id}
              jobId={shown}
              role={project.myRole}
            />
          )}
          {list.length > 1 && (
            <History jobs={list} selected={shown} onPick={setPicked} />
          )}
          {project.status === "ACTIVE" && can(project.myRole, "MAINTAINER") && (
            <CostPanel />
          )}
        </div>
      </div>
    </>
  );
}

function History({
  jobs,
  selected,
  onPick,
}: {
  jobs: ProvisioningJobWire[];
  selected: string | null;
  onPick: (id: string) => void;
}) {
  const m = useMessages(provisioningMessages).infra;
  return (
    <div className="table-wrap">
      <table className="dtable" aria-label={m.history}>
        <thead>
          <tr>
            <th scope="col">{m.started}</th>
            <th scope="col">{m.status}</th>
            <th scope="col" />
          </tr>
        </thead>
        <tbody>
          {jobs.map((j) => (
            <tr key={j.id}>
              <th scope="row">{formatDateTime(j.createdAt)}</th>
              <td>{jobStateLabel(j.state)}</td>
              <td>
                <button
                  type="button"
                  className="btn"
                  disabled={j.id === selected}
                  onClick={() => onPick(j.id)}
                >
                  {m.view}
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
