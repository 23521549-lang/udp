import { useQueries, useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { X } from "lucide-react";
import { useCallback, useRef, type ReactNode, type RefObject } from "react";
import { Icon } from "../../components/Icon";
import { Empty, ErrorState, Loading } from "../../components/States";
import { StatusLabel } from "../../components/StatusLabel";
import { useMessages } from "../../i18n";
import {
  formatDateTime,
  formatNumber,
  formatUsd,
  relativeTime,
} from "../../lib/format";
import { qk } from "../../lib/query-keys";
import { usePeekFocus } from "../../lib/use-peek-focus";
import { PROVIDER_LABEL } from "../project/cloud/cloud-labels";
import { cloudMessages } from "../project/cloud/cloud.messages";
import { ProjectStatus } from "../project/ProjectStatus";
import {
  jobStateLabel,
  jobTypeLabel,
  labelOf,
} from "../provisioning/provisioning-labels";
import { adminApi, type AdminProjectRow } from "./admin-api";
import { ADMIN_JOB_STATES } from "./admin-search";
import { adminMessages } from "./admin.messages";
import { credentialState } from "./credential-state";
import { JobErrorText, jobStateTone } from "./job-error";
import { useProjectDirectory } from "./project-directory";

/**
 * [Plan #58 UX-32] Panel chỉ-đọc của một project, mở từ tên project ở mọi danh sách của Bảng điều khiển (Project, Job
 * lỗi, Tài nguyên mồ côi, Credential) thay cho ngõ cụt: trạng thái, chủ, job lỗi gần nhất kèm câu lỗi đọc được, tài
 * nguyên mồ côi và credential. Id nằm trên URL (`?project=`); dữ liệu là các danh sách quản trị sẵn có (cùng query key
 * với các trang), nên không thêm route nào ở máy chủ. Focus và Esc theo `usePeekFocus`.
 */
export function useProjectPeek(
  projectId: string | undefined,
  setProject: (id: string | undefined) => void,
): ReactNode {
  const panel = useRef<HTMLElement>(null);
  const close = useCallback(() => setProject(undefined), [setProject]);
  usePeekFocus(panel, projectId, close);
  return projectId === undefined ? null : (
    <ProjectPeek panelRef={panel} projectId={projectId} onClose={close} />
  );
}

function ProjectPeek({
  panelRef,
  projectId,
  onClose,
}: {
  panelRef: RefObject<HTMLElement>;
  projectId: string;
  onClose: () => void;
}) {
  const m = useMessages(adminMessages).peek;
  const directory = useProjectDirectory();
  const project = directory.byId.get(projectId);
  return (
    <aside
      ref={panelRef}
      className="peek"
      aria-label={m.label(project?.name ?? "")}
      tabIndex={-1}
    >
      <div className="ph">
        <b className="ellipsis" translate="no">
          {project?.name ?? "…"}
        </b>
        <button
          type="button"
          className="ib ph-close"
          aria-label={m.close}
          onClick={onClose}
        >
          <Icon of={X} />
        </button>
      </div>
      <div className="inner">
        {project !== undefined ? (
          <PeekBody project={project} />
        ) : directory.isPending ? (
          <Loading />
        ) : directory.isError ? (
          <ErrorState error={directory.error} onRetry={directory.refetch} />
        ) : (
          <Empty title={m.notFound} />
        )}
      </div>
    </aside>
  );
}

function PeekSection({
  title,
  action,
  children,
}: {
  title: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section aria-label={title}>
      <div className="sect">
        <h3>{title}</h3>
        {action !== undefined && <div className="r">{action}</div>}
      </div>
      {children}
    </section>
  );
}

function PeekBody({ project: p }: { project: AdminProjectRow }) {
  const t = useMessages(adminMessages);
  const m = t.peek;
  return (
    <>
      <dl className="props">
        <dt>{t.projects.status}</dt>
        <dd>
          <ProjectStatus status={p.status} />
        </dd>
        <dt>{t.owner}</dt>
        <dd>
          <Link
            to="/admin/users"
            search={{ q: p.owner.email }}
            className="ellipsis"
            translate="no"
          >
            {p.owner.email}
          </Link>
        </dd>
        <dt>{t.cloud}</dt>
        <dd>
          {p.cloudProvider === null
            ? t.projects.notConnected
            : PROVIDER_LABEL[p.cloudProvider]}
        </dd>
        <dt>{t.projects.members}</dt>
        <dd className="num">{formatNumber(p.memberCount)}</dd>
        <dt>{t.created}</dt>
        <dd>{formatDateTime(p.createdAt)}</dd>
      </dl>
      <LastJob projectId={p.id} />
      <Credentials projectId={p.id} />
      <PeekSection
        title={m.orphans}
        action={
          <Link to="/admin/orphans" search={{ project: p.id }}>
            {m.openOrphans}
          </Link>
        }
      >
        <Orphans projectId={p.id} />
      </PeekSection>
    </>
  );
}

/** Job lỗi mới nhất của project trong trang đầu của ba tab Job lỗi — cùng cache với trang đó */
function LastJob({ projectId }: { projectId: string }) {
  const m = useMessages(adminMessages).peek;
  const lists = useQueries({
    queries: ADMIN_JOB_STATES.map((state) => ({
      queryKey: qk.adminJobs(state, 0),
      queryFn: () => adminApi.jobs(state, 0),
    })),
  });
  const failed = lists.find((q) => q.isError);
  const job = lists
    .flatMap((q) => q.data?.jobs ?? [])
    .filter((j) => j.project.id === projectId)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
  const state = ADMIN_JOB_STATES.find((s) => s === job?.state);
  return (
    <PeekSection
      title={m.lastJob}
      action={
        state !== undefined && (
          <Link to="/admin/jobs" search={{ state, project: projectId }}>
            {m.openJobs}
          </Link>
        )
      }
    >
      {job !== undefined ? (
        <div className="peek-job">
          <p className="job-h">
            <span>{jobTypeLabel(job.jobType)}</span>
            <StatusLabel tone={jobStateTone(job.state)}>
              {jobStateLabel(job.state)}
            </StatusLabel>
            <span className="c3" title={formatDateTime(job.updatedAt)}>
              {relativeTime(job.updatedAt)}
            </span>
          </p>
          <JobErrorText lastError={job.lastError} />
        </div>
      ) : lists.some((q) => q.isPending) ? (
        <Loading />
      ) : failed !== undefined ? (
        <ErrorState
          error={failed.error}
          onRetry={() => void failed.refetch()}
        />
      ) : (
        <p className="c3">{m.noJob}</p>
      )}
    </PeekSection>
  );
}

function Credentials({ projectId }: { projectId: string }) {
  const t = useMessages(adminMessages);
  const auth = useMessages(cloudMessages).authKind;
  const creds = useQuery({
    queryKey: qk.adminCredentials(),
    queryFn: adminApi.credentials,
  });
  const mine = creds.data?.credentials.filter(
    (c) => c.project.id === projectId,
  );
  return (
    <PeekSection title={t.peek.credential}>
      {creds.isPending ? (
        <Loading />
      ) : creds.isError ? (
        <ErrorState error={creds.error} onRetry={() => void creds.refetch()} />
      ) : mine === undefined || mine.length === 0 ? (
        <p className="c3">{t.peek.noCredential}</p>
      ) : (
        <ul className="peek-list">
          {mine.map((c) => {
            const s = credentialState(c);
            return (
              <li key={c.id}>
                <span>
                  {PROVIDER_LABEL[c.provider]} ·{" "}
                  {labelOf(t.credentials.modes, c.mode)} ·{" "}
                  {labelOf(auth, c.authKind)}
                </span>
                <StatusLabel tone={s.tone}>
                  {t.credentials.state[s.state]}
                </StatusLabel>
              </li>
            );
          })}
        </ul>
      )}
    </PeekSection>
  );
}

function Orphans({ projectId }: { projectId: string }) {
  const t = useMessages(adminMessages);
  const orphans = useQuery({
    queryKey: qk.adminOrphans(),
    queryFn: adminApi.orphans,
  });
  if (orphans.isPending) return <Loading />;
  if (orphans.isError) {
    return (
      <ErrorState
        error={orphans.error}
        onRetry={() => void orphans.refetch()}
      />
    );
  }
  const mine = orphans.data.resources.filter((r) => r.projectId === projectId);
  if (mine.length === 0) return <p className="c3">{t.peek.noOrphans}</p>;
  return (
    <ul className="peek-list">
      {mine.map((r) => (
        <li key={r.id}>
          <span className="mono" translate="no">
            {r.kind}
          </span>
          <span className="mono c3 ellipsis" translate="no">
            {r.providerId ?? t.orphans.unknownId}
          </span>
          <span className="num">
            {r.usdPerHour === null
              ? t.orphans.unpriced
              : t.overview.perHour(formatUsd(r.usdPerHour))}
          </span>
        </li>
      ))}
    </ul>
  );
}
