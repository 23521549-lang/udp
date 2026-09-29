import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import type {
  AdminOverviewWire,
  AdminPlatformWire,
} from "@udp/shared-types/wire";
import type { ReactNode } from "react";
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
import { jobTypeLabel } from "../../provisioning/provisioning-labels";
import { AdminPage } from "../AdminLayout";
import { adminApi } from "../admin-api";
import { adminMessages } from "../admin.messages";
import {
  backupVerdict,
  certificateVerdict,
  idleRisk,
  platformReason,
  serviceStatus,
  type PlatformUnavailableReason,
} from "../platform-model";

const RECENT_FAILED_JOBS = 5;

/**
 * Tổng quan của Bảng điều khiển (Plan #53 QĐ-6, QĐ-7): nền tảng có khoẻ không (máy, database, sao lưu,
 * chứng chỉ, bản phát hành, ba service) và có còn 0 đồng không (tài nguyên mồ côi), rồi số liệu nền
 * tảng. Ba nguồn tải và báo lỗi riêng: cụm không đọc được không che mất số liệu của database.
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

  return (
    <AdminPage
      title={m.title}
      lead={m.lead}
      minis={
        o === undefined
          ? undefined
          : [
              { value: o.users.total, label: m.users(o.users.total) },
              { value: o.projects.total, label: m.projects(o.projects.total) },
              {
                value: o.jobs.failed + o.jobs.compensationFailed,
                label: m.failedJobs(o.jobs.failed + o.jobs.compensationFailed),
              },
            ]
      }
    >
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
            [
              ...system.data.services,
              { name: "database", status: system.data.database },
            ].map((s) => {
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

function PlatformSignals({
  platform: p,
  databaseBytes,
}: {
  platform: AdminPlatformWire;
  databaseBytes: number | null;
}) {
  const m = useMessages(adminMessages).overview;
  return (
    <div className="kpis sig-grid">
      <Signal title={m.machine}>
        {p.node.state === "unavailable" ? (
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
        )}
      </Signal>

      <Signal title={m.database}>
        {p.postgresVolume.state === "unavailable" ? (
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
        )}
      </Signal>

      <Signal title={m.backup}>
        {p.backup.state === "unavailable" ? (
          <Unavailable reason={p.backup.reason} />
        ) : (
          <BackupBody backup={p.backup} />
        )}
      </Signal>

      <Signal title={m.certificate}>
        {p.certificate.state === "unavailable" ? (
          <Unavailable reason={p.certificate.reason} />
        ) : (
          <CertificateBody certificate={p.certificate} />
        )}
      </Signal>

      <Signal title={m.release}>
        {p.release === null ? (
          <StatusLabel tone="unknown">{m.noRelease}</StatusLabel>
        ) : (
          <span className="mono" translate="no">
            {p.release}
          </span>
        )}
      </Signal>
    </div>
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
        {risk.tone === "ok" ? m.notIdle : m.idleRisk}
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
  return (
    <>
      <StatusLabel tone={verdict.tone}>{verdict.label}</StatusLabel>
      <dl className="props compact">
        <dt>{m.schedule}</dt>
        <dd className="mono" translate="no">
          {b.schedule}
        </dd>
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
  const toolMax = Math.max(1, ...o.tools.map((tool) => tool.projects));
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
            <div className="c3">
              {m.projectsSub(
                o.projects.byStatus.ACTIVE,
                o.projects.byStatus.PROVISIONING,
                o.projects.byStatus.ERROR,
                o.projects.byStatus.DRAFT,
              )}
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
            <div className="l">{m.orphans}</div>
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
              <Link to="/admin/jobs" search={{}} className="btn">
                {m.allFailedJobs}
              </Link>
            </div>
          </div>
          <dl className="props compact">
            <dt>{m.running}</dt>
            <dd className="num">{o.jobs.running}</dd>
            <dt>{m.failed}</dt>
            <dd className="num">{o.jobs.failed}</dd>
            <dt>{m.compensationFailed}</dt>
            <dd className="num">{o.jobs.compensationFailed}</dd>
            <dt>{m.cancelling}</dt>
            <dd className="num">{o.jobs.cancelRequested}</dd>
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

/** Năm job lỗi gần nhất — cùng khoá cache với trang Job lỗi, trang 1 */
function RecentFailedJobs() {
  const m = useMessages(adminMessages).overview;
  const jobs = useQuery({
    queryKey: qk.adminJobs("FAILED", 0),
    queryFn: () => adminApi.jobs("FAILED", 0),
  });
  if (jobs.isPending) return <Loading />;
  if (jobs.isError) {
    return (
      <ErrorState error={jobs.error} onRetry={() => void jobs.refetch()} />
    );
  }
  const recent = jobs.data.jobs.slice(0, RECENT_FAILED_JOBS);
  if (recent.length === 0) return <p className="c3">{m.noFailedJobs}</p>;
  return (
    <ul className="lst" aria-label={m.recentFailed}>
      {recent.map((j) => (
        <li key={j.id} className="it">
          <span>{jobTypeLabel(j.jobType)}</span>
          <span className="c3" translate="no">
            {j.project.name}
          </span>
          <span className="lst-end c3 num" title={formatDateTime(j.updatedAt)}>
            {relativeTime(j.updatedAt)}
          </span>
        </li>
      ))}
    </ul>
  );
}
