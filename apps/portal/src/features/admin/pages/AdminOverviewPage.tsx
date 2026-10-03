import { useQueries, useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import type {
  AdminOverviewWire,
  AdminPlatformWire,
  AdminSystemWire,
} from "@udp/shared-types/wire";
import { ExternalLink } from "lucide-react";
import { useState, type ReactNode } from "react";
import { Icon } from "../../../components/Icon";
import type { Mini } from "../../../components/PageHead";
import { InfoTip } from "../../../components/InfoTip";
import { Meter } from "../../../components/Meter";
import { ErrorState, Loading } from "../../../components/States";
import { StatusLabel } from "../../../components/StatusLabel";
import { useMessages } from "../../../i18n";
import {
  formatBytes,
  formatDateTime,
  formatNumber,
  formatUsd,
  relativeTime,
} from "../../../lib/format";
import { qk } from "../../../lib/query-keys";
import { PROVIDER_LABEL } from "../../project/cloud/cloud-labels";
import { projectStatusMessages } from "../../project/project-status.messages";
import {
  jobStateLabel,
  jobTypeLabel,
} from "../../provisioning/provisioning-labels";
import { AdminPage } from "../AdminLayout";
import { adminApi } from "../admin-api";
import { ADMIN_JOB_STATES, defaultJobState, jobCounts } from "../admin-search";
import { adminMessages } from "../admin.messages";
import { needsAttention, type AttentionItem } from "../attention";
import {
  backupVerdict,
  certificateVerdict,
  dailyAtVietnam,
  greenSignals,
  idleRisk,
  platformReason,
  serviceStatus,
  type PlatformSignal,
  type PlatformUnavailableReason,
} from "../platform-model";

const RECENT_FAILED_JOBS = 5;

/** Nơi xem lịch sử 7 ngày của máy ảo và xử lý nguy cơ thu hồi */
const ORACLE_CONSOLE = "https://cloud.oracle.com/compute/instances";

/**
 * Tổng quan của Bảng điều khiển (Plan #53 QĐ-6, QĐ-7): nền tảng có khoẻ không (máy, database, sao lưu,
 * chứng chỉ, bản phát hành, ba service) và có còn 0 đồng không (tài nguyên mồ côi), rồi số liệu nền
 * tảng. Ba nguồn tải và báo lỗi riêng: cụm không đọc được không che mất số liệu của database.
 *
 * [Plan #58 UX-27] Mở đầu bằng dải "Cần xử lý" dựng từ chính ba nguồn đó; tín hiệu xanh gọn thành một dòng, tín hiệu
 * cần xem giữ thẻ đầy đủ; ba số ở đầu trang là link tới danh sách của chúng.
 */
export function AdminOverviewPage() {
  const t = useMessages(adminMessages);
  const m = t.overview;
  const overview = useQuery({
    queryKey: qk.adminOverview(),
    queryFn: adminApi.overview,
    refetchInterval: 60_000,
  });
  const platform = useQuery({
    queryKey: qk.adminPlatform(),
    queryFn: adminApi.platform,
    refetchInterval: 60_000,
  });
  const system = useQuery({
    queryKey: qk.adminSystem(),
    queryFn: adminApi.system,
    refetchInterval: 30_000,
  });
  const o = overview.data?.overview;
  const sources = [overview, platform, system];

  return (
    <AdminPage
      title={m.title}
      lead={m.lead}
      minis={o === undefined ? undefined : headNumbers(o, m)}
    >
      <AttentionStrip
        overview={o}
        platform={platform.data?.platform}
        system={system.data}
        settled={sources.every((q) => !q.isPending)}
        failed={sources.some((q) => q.isError)}
      />

      <section aria-labelledby="ad-machine">
        <div className="sect">
          <h2 id="ad-machine">{m.machineHeading}</h2>
          {platform.data !== undefined && (
            <span className="c3">
              {t.readAt(formatDateTime(platform.data.platform.checkedAt))}
            </span>
          )}
        </div>
        {platform.isPending ? (
          <Loading />
        ) : platform.isError ? (
          <ErrorState
            error={platform.error}
            onRetry={() => void platform.refetch()}
          />
        ) : (
          <PlatformSignals
            platform={platform.data.platform}
            databaseBytes={o?.database.sizeBytes ?? null}
          />
        )}
        <ul className="sig-list" aria-label={m.services}>
          {system.isPending ? (
            <li className="c3">{m.checkingServices}</li>
          ) : system.isError ? (
            <li>
              <ErrorState
                error={system.error}
                onRetry={() => void system.refetch()}
              />
            </li>
          ) : (
            servicesOf(system.data).map((s) => {
              const health = serviceStatus(s.status);
              return (
                <li key={s.name} className="sig">
                  <span className="mono" translate="no">
                    {s.name}
                  </span>
                  <StatusLabel tone={health.tone}>{health.label}</StatusLabel>
                </li>
              );
            })
          )}
        </ul>
      </section>

      {overview.isPending ? (
        <Loading />
      ) : overview.isError ? (
        <ErrorState
          error={overview.error}
          onRetry={() => void overview.refetch()}
        />
      ) : (
        <OverviewNumbers overview={overview.data.overview} />
      )}
    </AdminPage>
  );
}

const servicesOf = (s: AdminSystemWire) => [
  ...s.services,
  { name: "database", status: s.database },
];

type OverviewCopy = (typeof adminMessages)["vi"]["overview"];

/** [Plan #58 UX-27] Ba số ở đầu trang là link tới danh sách của chính chúng */
function headNumbers(o: AdminOverviewWire, m: OverviewCopy): Mini[] {
  const failed = o.jobs.failed + o.jobs.compensationFailed;
  const users = m.users(o.users.total);
  const projects = m.projects(o.projects.total);
  const jobs = m.failedJobs(failed);
  const n = formatNumber;
  return [
    {
      label: users,
      value: (
        <Link to="/admin/users" aria-label={`${n(o.users.total)} ${users}`}>
          {n(o.users.total)}
        </Link>
      ),
    },
    {
      label: projects,
      value: (
        <Link
          to="/admin/projects"
          aria-label={`${n(o.projects.total)} ${projects}`}
        >
          {n(o.projects.total)}
        </Link>
      ),
    },
    {
      label: jobs,
      value: (
        <Link
          to="/admin/jobs"
          search={{ state: defaultJobState(jobCounts(o)) }}
          aria-label={`${n(failed)} ${jobs}`}
        >
          {n(failed)}
        </Link>
      ),
    },
  ];
}

// ------------------------------------------------------------------ cần xử lý

function AttentionStrip({
  overview,
  platform,
  system,
  settled,
  failed,
}: {
  overview: AdminOverviewWire | undefined;
  platform: AdminPlatformWire | undefined;
  system: AdminSystemWire | undefined;
  settled: boolean;
  failed: boolean;
}) {
  const m = useMessages(adminMessages).overview.attention;
  const { items, unreadable } = needsAttention({ overview, platform, system });
  return (
    <section className="attn" aria-labelledby="ad-attn">
      <div className="sect">
        <h2 id="ad-attn">{m.heading}</h2>
      </div>
      {items.length > 0 ? (
        <ul className="attn-list" aria-labelledby="ad-attn">
          {items.map((item) => (
            <AttentionRow key={`${item.kind}-${rowKey(item)}`} item={item} />
          ))}
        </ul>
      ) : !settled ? (
        <p className="c3">{m.checking}</p>
      ) : failed ? (
        <p>
          <StatusLabel tone="unknown">{m.partial}</StatusLabel>
        </p>
      ) : unreadable > 0 ? (
        <p>
          <StatusLabel tone="unknown">{m.noUrgent(unreadable)}</StatusLabel>
        </p>
      ) : (
        <p>
          <StatusLabel tone="ok">{m.allGood}</StatusLabel>
        </p>
      )}
    </section>
  );
}

const rowKey = (item: AttentionItem): string =>
  item.kind === "service" ? item.name : "";

function AttentionRow({ item }: { item: AttentionItem }) {
  const m = useMessages(adminMessages).overview.attention;
  const status = useMessages(projectStatusMessages).status;
  const a = m.action;
  let text: ReactNode;
  let action: ReactNode;
  switch (item.kind) {
    case "cleanup":
      text = m.cleanup(item.count);
      action = (
        <Link to="/admin/jobs" search={{ state: "COMPENSATION_FAILED" }}>
          {a.jobs}
        </Link>
      );
      break;
    case "orphans":
      text = m.orphans(item.count, formatUsd(item.usdPerHour), item.unpriced);
      action = <Link to="/admin/orphans">{a.orphans}</Link>;
      break;
    case "errorProjects":
      text = m.errorProjects(item.count, status.ERROR);
      action = (
        <Link to="/admin/projects" search={{ status: "ERROR" }}>
          {a.projects}
        </Link>
      );
      break;
    case "service":
      text = m.service(
        <span className="mono" translate="no">
          {item.name}
        </span>,
      );
      action = <Link to="/admin/architecture">{a.architecture}</Link>;
      break;
    case "backup":
      text = m.backup(item.label);
      action = <Link to="/admin/architecture">{a.architecture}</Link>;
      break;
    case "certificate":
      text = m.certificate(item.label);
      action = <Link to="/admin/architecture">{a.architecture}</Link>;
      break;
    case "idle":
      text = m.idle;
      action = (
        <a href={ORACLE_CONSOLE} target="_blank" rel="noreferrer">
          {a.oracle}
          <Icon of={ExternalLink} size={12} />
        </a>
      );
      break;
  }
  return (
    <li className={`attn-it ${item.tone}`}>
      <StatusLabel tone={item.tone}>{text}</StatusLabel>
      <span className="attn-act">{action}</span>
    </li>
  );
}

// ------------------------------------------------------------------ tín hiệu của cụm

function Signal({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="kpi sig-card" aria-label={title}>
      <h3 className="l">{title}</h3>
      {children}
    </section>
  );
}

function Unavailable({ reason }: { reason: PlatformUnavailableReason }) {
  return <StatusLabel tone="unknown">{platformReason(reason)}</StatusLabel>;
}

interface SignalView {
  key: PlatformSignal;
  title: string;
  /** Dòng gọn khi tín hiệu xanh hẳn */
  short: ReactNode;
  card: ReactNode;
}

/**
 * [Plan #58 UX-27] Tín hiệu xanh hẳn gọn thành một dòng (`greenSignals`), tín hiệu cần xem giữ thẻ đầy đủ; "Xem chi
 * tiết" mở lại thẻ của mọi tín hiệu.
 */
function PlatformSignals({
  platform: p,
  databaseBytes,
}: {
  platform: AdminPlatformWire;
  databaseBytes: number | null;
}) {
  const m = useMessages(adminMessages).overview;
  const [expanded, setExpanded] = useState(false);
  const green = greenSignals(p, databaseBytes);
  const ok = (text: ReactNode) => <StatusLabel tone="ok">{text}</StatusLabel>;
  const signals: SignalView[] = [
    {
      key: "machine",
      title: m.machine,
      short: ok(m.aboveIdle),
      card:
        p.node.state === "unavailable" ? (
          <Unavailable reason={p.node.reason} />
        ) : (
          <>
            <span className="mono c3" translate="no">
              {p.node.name}
            </span>
            <Meter
              label="CPU"
              value={p.node.cpuUsedCores}
              max={p.node.cpuCores}
              format={m.cores}
            />
            <Meter
              label="RAM"
              value={p.node.memoryUsedBytes}
              max={p.node.memoryBytes}
              format={formatBytes}
            />
            <IdleRisk node={p.node} />
          </>
        ),
    },
    {
      key: "database",
      title: m.database,
      short: ok(
        p.postgresVolume.state === "ok" && databaseBytes !== null
          ? `${formatBytes(databaseBytes)} / ${formatBytes(p.postgresVolume.capacityBytes)}`
          : m.database,
      ),
      card:
        p.postgresVolume.state === "unavailable" ? (
          <>
            {databaseBytes !== null && (
              <span>{m.dataSize(formatBytes(databaseBytes))}</span>
            )}
            <Unavailable reason={p.postgresVolume.reason} />
          </>
        ) : databaseBytes === null ? (
          <span>
            {m.volumeOnly(formatBytes(p.postgresVolume.capacityBytes))}
          </span>
        ) : (
          <Meter
            label="PostgreSQL"
            value={databaseBytes}
            max={p.postgresVolume.capacityBytes}
            format={formatBytes}
          />
        ),
    },
    {
      key: "backup",
      title: m.backup,
      short: p.backup.state === "ok" ? ok(backupVerdict(p.backup).label) : null,
      card:
        p.backup.state === "unavailable" ? (
          <Unavailable reason={p.backup.reason} />
        ) : (
          <BackupBody backup={p.backup} />
        ),
    },
    {
      key: "certificate",
      title: m.certificate,
      short:
        p.certificate.state === "ok"
          ? ok(certificateVerdict(p.certificate).label)
          : null,
      card:
        p.certificate.state === "unavailable" ? (
          <Unavailable reason={p.certificate.reason} />
        ) : (
          <CertificateBody certificate={p.certificate} />
        ),
    },
    {
      key: "release",
      title: m.release,
      short: (
        <span className="mono" translate="no">
          {p.release}
        </span>
      ),
      card:
        p.release === null ? (
          <>
            <StatusLabel tone="unknown">{m.releaseUnknown}</StatusLabel>
            <p className="sig-note c3">{m.releaseHint}</p>
          </>
        ) : (
          <span className="mono" translate="no">
            {p.release}
          </span>
        ),
    },
  ];
  const cards = signals.filter((s) => expanded || !green[s.key]);
  const compact = signals.filter((s) => !expanded && green[s.key]);
  const anyGreen = signals.some((s) => green[s.key]);
  return (
    <>
      {cards.length > 0 && (
        <div className="kpis sig-grid">
          {cards.map((s) => (
            <Signal key={s.key} title={s.title}>
              {s.card}
            </Signal>
          ))}
        </div>
      )}
      {compact.length > 0 && (
        <ul className="sig-list sig-green" aria-label={m.machineHeading}>
          {compact.map((s) => (
            <li key={s.key} className="sig">
              <span>{s.title}</span>
              {s.short}
            </li>
          ))}
        </ul>
      )}
      {anyGreen && (
        <p className="sig-more">
          <button
            type="button"
            className="linkbtn"
            aria-expanded={expanded}
            onClick={() => setExpanded((v) => !v)}
          >
            {expanded ? m.hideDetails : m.showDetails}
          </button>
        </p>
      )}
    </>
  );
}

function IdleRisk({
  node,
}: {
  node: Extract<AdminPlatformWire["node"], { state: "ok" }>;
}) {
  const m = useMessages(adminMessages).overview;
  const risk = idleRisk(node);
  return (
    <p className="sig-note">
      <StatusLabel tone={risk.tone}>
        {risk.tone === "ok" ? m.aboveIdle : m.idleRisk}
      </StatusLabel>
      <span className="c3">{risk.text}</span>
    </p>
  );
}

function BackupBody({
  backup: b,
}: {
  backup: Extract<AdminPlatformWire["backup"], { state: "ok" }>;
}) {
  const m = useMessages(adminMessages).overview;
  const verdict = backupVerdict(b);
  const daily = dailyAtVietnam(b.schedule);
  return (
    <>
      <StatusLabel tone={verdict.tone}>{verdict.label}</StatusLabel>
      <dl className="props compact">
        <dt>{m.schedule}</dt>
        {daily === null ? (
          <dd className="mono" translate="no">
            {b.schedule}
          </dd>
        ) : (
          <dd title={m.cron(b.schedule)}>{m.daily(daily)}</dd>
        )}
        <dt>{m.lastSuccess}</dt>
        <dd>
          {b.lastSuccessAt === null ? m.none : relativeTime(b.lastSuccessAt)}
        </dd>
        <dt>{m.lastFailure}</dt>
        <dd>
          {b.lastFailureAt === null ? m.none : relativeTime(b.lastFailureAt)}
        </dd>
      </dl>
    </>
  );
}

function CertificateBody({
  certificate: c,
}: {
  certificate: Extract<AdminPlatformWire["certificate"], { state: "ok" }>;
}) {
  const m = useMessages(adminMessages).overview;
  const verdict = certificateVerdict(c);
  return (
    <>
      <StatusLabel tone={verdict.tone}>{verdict.label}</StatusLabel>
      <dl className="props compact">
        <dt>{m.expires}</dt>
        <dd>
          {c.notAfter === null ? m.notIssued : formatDateTime(c.notAfter)}
        </dd>
        <dt>{m.issuer}</dt>
        <dd>{c.issuer ?? m.unknown}</dd>
      </dl>
    </>
  );
}

// ------------------------------------------------------------------ số liệu nền tảng

function OverviewNumbers({ overview: o }: { overview: AdminOverviewWire }) {
  const t = useMessages(adminMessages);
  const m = t.overview;
  const status = useMessages(projectStatusMessages).status;
  const toolMax = Math.max(1, ...o.tools.map((tool) => tool.projects));
  const counts = jobCounts(o);
  return (
    <>
      <section aria-labelledby="ad-numbers">
        <div className="sect">
          <h2 id="ad-numbers">{m.numbers}</h2>
          <span className="c3">{t.readAt(formatDateTime(o.generatedAt))}</span>
        </div>
        <div className="stat">
          <div>
            <div className="l">{m.usersStat}</div>
            <div className="v num">{formatNumber(o.users.total)}</div>
            <div className="c3">
              {m.usersSub(o.users.admins, o.users.newLast7d)}
            </div>
          </div>
          <div>
            <div className="l">{m.projectsStat}</div>
            <div className="v num">{formatNumber(o.projects.total)}</div>
            {/* [Plan #58 UX-8] Cùng chữ trạng thái với danh sách Project */}
            <div className="c3">
              {(["ACTIVE", "PROVISIONING", "ERROR", "DRAFT"] as const)
                .map(
                  (s) => `${status[s]} ${formatNumber(o.projects.byStatus[s])}`,
                )
                .join(" · ")}
            </div>
          </div>
          <div>
            <div className="l">{m.deploys}</div>
            <div className="v num">
              {formatNumber(o.deploys7d.success + o.deploys7d.failure)}
            </div>
            <div className="c3">{m.deploysFailed(o.deploys7d.failure)}</div>
          </div>
          <div>
            <div className="l">
              {m.orphans}
              <InfoTip term="orphan" />
            </div>
            <div className="v num">{formatNumber(o.orphans.count)}</div>
            <div className="c3">
              {m.perHour(formatUsd(o.orphans.usdPerHour))}
              {o.orphans.unpriced > 0 && `, ${m.unpriced(o.orphans.unpriced)}`}
            </div>
          </div>
        </div>
      </section>

      <div className="ad-cols">
        <section aria-labelledby="ad-jobs">
          <div className="sect">
            <h2 id="ad-jobs">{m.jobs}</h2>
            <div className="r">
              <Link
                to="/admin/jobs"
                search={{ state: defaultJobState(counts) }}
                className="btn"
              >
                {m.allFailedJobs}
              </Link>
            </div>
          </div>
          {/* [Plan #58 UX-8, UX-28] Cùng tên trạng thái với các tab của Job lỗi; mỗi số mở đúng tab */}
          <dl className="props compact">
            <dt>{m.running}</dt>
            <dd className="num">{formatNumber(o.jobs.running)}</dd>
            {ADMIN_JOB_STATES.map((s) => (
              <JobCount key={s} state={s} n={counts[s]} />
            ))}
          </dl>
          <RecentFailedJobs />
        </section>

        <section aria-labelledby="ad-clouds">
          <div className="sect">
            <h2 id="ad-clouds">{m.byCloud}</h2>
          </div>
          {o.clouds.length === 0 ? (
            <p className="c3">{m.noCloud}</p>
          ) : (
            o.clouds.map((c) => (
              <Meter
                key={c.provider}
                label={PROVIDER_LABEL[c.provider]}
                value={c.projects}
                max={Math.max(1, o.projects.total)}
                format={formatNumber}
              />
            ))
          )}
          {o.orphans.count > 0 && (
            <p className="c3">
              {m.orphanCost(
                o.orphans.count,
                formatUsd(o.orphans.usdPerHour),
                <Link to="/admin/orphans">{m.viewOrphans}</Link>,
              )}
            </p>
          )}
        </section>
      </div>

      <section aria-labelledby="ad-tools">
        <div className="sect">
          <h2 id="ad-tools">{m.topTools}</h2>
          <div className="r">
            <Link to="/admin/catalog" className="btn">
              {m.catalog}
            </Link>
          </div>
        </div>
        {o.tools.length === 0 ? (
          <p className="c3">{m.noTools}</p>
        ) : (
          <table className="dtable" aria-labelledby="ad-tools">
            <thead>
              <tr>
                <th scope="col">{m.tool}</th>
                <th scope="col">{t.domain}</th>
                <th scope="col" className="num">
                  {m.projectsStat}
                </th>
                <th scope="col">
                  <span className="visually-hidden">{m.share}</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {o.tools.map((tool) => (
                <tr key={`${tool.domainType}:${tool.toolId}`}>
                  <td className="mono" translate="no">
                    {tool.toolId}
                  </td>
                  <td className="mono c3" translate="no">
                    {tool.domainType}
                  </td>
                  <td className="num">{tool.projects}</td>
                  <td className="tool-bar">
                    <i
                      style={{
                        transform: `scaleX(${String(tool.projects / toolMax)})`,
                      }}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </>
  );
}

function JobCount({
  state,
  n,
}: {
  state: (typeof ADMIN_JOB_STATES)[number];
  n: number;
}) {
  return (
    <>
      <dt>{jobStateLabel(state)}</dt>
      <dd className="num">
        {n === 0 ? (
          formatNumber(n)
        ) : (
          <Link to="/admin/jobs" search={{ state }}>
            {formatNumber(n)}
          </Link>
        )}
      </dd>
    </>
  );
}

/**
 * Năm job lỗi gần nhất (thất bại và dọn chưa hết) — cùng khoá cache với trang 1 của hai tab Job lỗi. Mỗi dòng mở
 * đúng tab, với panel của project đó.
 */
function RecentFailedJobs() {
  const m = useMessages(adminMessages).overview;
  const lists = useQueries({
    queries: (["COMPENSATION_FAILED", "FAILED"] as const).map((state) => ({
      queryKey: qk.adminJobs(state, 0),
      queryFn: () => adminApi.jobs(state, 0),
    })),
  });
  const failed = lists.find((q) => q.isError);
  if (lists.some((q) => q.isPending)) return <Loading />;
  if (failed !== undefined) {
    return (
      <ErrorState error={failed.error} onRetry={() => void failed.refetch()} />
    );
  }
  const recent = lists
    .flatMap((q) => q.data?.jobs ?? [])
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, RECENT_FAILED_JOBS);
  if (recent.length === 0) return <p className="c3">{m.noFailedJobs}</p>;
  return (
    <ul className="lst" aria-label={m.recentFailed}>
      {recent.map((j) => {
        const state = ADMIN_JOB_STATES.find((s) => s === j.state) ?? "FAILED";
        return (
          <li key={j.id}>
            <Link
              to="/admin/jobs"
              search={{ state, project: j.project.id }}
              className="it"
            >
              <span>{jobTypeLabel(j.jobType)}</span>
              <span className="c3" translate="no">
                {j.project.name}
              </span>
              <span
                className="lst-end c3 num"
                title={formatDateTime(j.updatedAt)}
              >
                {relativeTime(j.updatedAt)}
              </span>
            </Link>
          </li>
        );
      })}
    </ul>
  );
}
