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
import {
  formatBytes,
  formatDateTime,
  formatDecimal,
  formatNumber,
  formatUsd,
  relativeTime,
} from "../../../lib/format";
import { qk } from "../../../lib/query-keys";
import { PROVIDER_LABEL } from "../../project/cloud/cloud-labels";
import { jobTypeLabel } from "../../provisioning/provisioning-labels";
import { AdminPage } from "../AdminLayout";
import { adminApi } from "../admin-api";
import {
  backupVerdict,
  certificateVerdict,
  idleRisk,
  PLATFORM_REASON,
  SERVICE_STATUS,
} from "../platform-model";

const RECENT_FAILED_JOBS = 5;

/**
 * Tổng quan của Bảng điều khiển (Plan #53 QĐ-6, QĐ-7): nền tảng có khoẻ không (máy, database, sao lưu,
 * chứng chỉ, bản phát hành, ba service) và có còn 0 đồng không (tài nguyên mồ côi), rồi số liệu nền
 * tảng. Ba nguồn tải và báo lỗi riêng: cụm không đọc được không che mất số liệu của database.
 */
export function AdminOverviewPage() {
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
      title="Tổng quan"
      lead="Sức khoẻ của máy chạy UDP và số liệu toàn nền tảng."
      minis={
        o === undefined
          ? undefined
          : [
              { value: o.users.total, label: "người dùng" },
              { value: o.projects.total, label: "project" },
              {
                value: o.jobs.failed + o.jobs.compensationFailed,
                label: "job lỗi",
              },
            ]
      }
    >
      <section aria-labelledby="ad-machine">
        <div className="sect">
          <h2 id="ad-machine">Máy chạy UDP</h2>
          {platform.data !== undefined && (
            <span className="c3">
              Đọc lúc {formatDateTime(platform.data.platform.checkedAt)}
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
        <ul className="sig-list" aria-label="Service">
          {system.isPending ? (
            <li className="c3">Đang kiểm service…</li>
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
            ].map((s) => (
              <li key={s.name} className="sig">
                <span className="mono" translate="no">
                  {s.name}
                </span>
                <StatusLabel tone={SERVICE_STATUS[s.status].tone}>
                  {SERVICE_STATUS[s.status].label}
                </StatusLabel>
              </li>
            ))
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

function Unavailable({ reason }: { reason: keyof typeof PLATFORM_REASON }) {
  return <StatusLabel tone="unknown">{PLATFORM_REASON[reason]}</StatusLabel>;
}

function PlatformSignals({
  platform: p,
  databaseBytes,
}: {
  platform: AdminPlatformWire;
  databaseBytes: number | null;
}) {
  return (
    <div className="kpis sig-grid">
      <Signal title="Máy">
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
              format={(n) => `${formatDecimal(n)} lõi`}
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

      <Signal title="Database">
        {p.postgresVolume.state === "unavailable" ? (
          <>
            {databaseBytes !== null && (
              <span>Dữ liệu {formatBytes(databaseBytes)}</span>
            )}
            <Unavailable reason={p.postgresVolume.reason} />
          </>
        ) : databaseBytes === null ? (
          <span>
            Ổ {formatBytes(p.postgresVolume.capacityBytes)}, chưa đọc được dung
            lượng dữ liệu
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

      <Signal title="Sao lưu">
        {p.backup.state === "unavailable" ? (
          <Unavailable reason={p.backup.reason} />
        ) : (
          <BackupBody backup={p.backup} />
        )}
      </Signal>

      <Signal title="Chứng chỉ HTTPS">
        {p.certificate.state === "unavailable" ? (
          <Unavailable reason={p.certificate.reason} />
        ) : (
          <CertificateBody certificate={p.certificate} />
        )}
      </Signal>

      <Signal title="Bản phát hành">
        {p.release === null ? (
          <StatusLabel tone="unknown">Không khai UDP_RELEASE</StatusLabel>
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
  const risk = idleRisk(node);
  return (
    <p className="sig-note">
      <StatusLabel tone={risk.tone}>
        {risk.tone === "ok" ? "Không rảnh" : "Nguy cơ bị thu hồi"}
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
  const verdict = backupVerdict(b);
  return (
    <>
      <StatusLabel tone={verdict.tone}>{verdict.label}</StatusLabel>
      <dl className="props compact">
        <dt>Lịch</dt>
        <dd className="mono" translate="no">
          {b.schedule}
        </dd>
        <dt>Thành công</dt>
        <dd>
          {b.lastSuccessAt === null ? "Chưa có" : relativeTime(b.lastSuccessAt)}
        </dd>
        <dt>Thất bại</dt>
        <dd>
          {b.lastFailureAt === null ? "Chưa có" : relativeTime(b.lastFailureAt)}
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
  const verdict = certificateVerdict(c);
  return (
    <>
      <StatusLabel tone={verdict.tone}>{verdict.label}</StatusLabel>
      <dl className="props compact">
        <dt>Hết hạn</dt>
        <dd>{c.notAfter === null ? "Chưa cấp" : formatDateTime(c.notAfter)}</dd>
        <dt>Nơi cấp</dt>
        <dd>{c.issuer ?? "Không rõ"}</dd>
      </dl>
    </>
  );
}

// ------------------------------------------------------------------ số liệu nền tảng

function OverviewNumbers({ overview: o }: { overview: AdminOverviewWire }) {
  const toolMax = Math.max(1, ...o.tools.map((t) => t.projects));
  return (
    <>
      <section aria-labelledby="ad-numbers">
        <div className="sect">
          <h2 id="ad-numbers">Số liệu nền tảng</h2>
          <span className="c3">Đọc lúc {formatDateTime(o.generatedAt)}</span>
        </div>
        <div className="stat">
          <div>
            <div className="l">Người dùng</div>
            <div className="v num">{formatNumber(o.users.total)}</div>
            <div className="c3">
              {o.users.admins} quản trị, {o.users.newLast7d} mới trong 7 ngày
            </div>
          </div>
          <div>
            <div className="l">Project</div>
            <div className="v num">{formatNumber(o.projects.total)}</div>
            <div className="c3">
              {o.projects.byStatus.ACTIVE} ổn định,{" "}
              {o.projects.byStatus.PROVISIONING} đang dựng,{" "}
              {o.projects.byStatus.ERROR} lỗi, {o.projects.byStatus.DRAFT} nháp
            </div>
          </div>
          <div>
            <div className="l">Deploy 7 ngày</div>
            <div className="v num">
              {formatNumber(o.deploys7d.success + o.deploys7d.failure)}
            </div>
            <div className="c3">{o.deploys7d.failure} thất bại</div>
          </div>
          <div>
            <div className="l">Tài nguyên mồ côi</div>
            <div className="v num">{formatNumber(o.orphans.count)}</div>
            <div className="c3">
              {formatUsd(o.orphans.usdPerHour)}/giờ
              {o.orphans.unpriced > 0 &&
                `, ${String(o.orphans.unpriced)} chưa có giá`}
            </div>
          </div>
        </div>
      </section>

      <div className="ad-cols">
        <section aria-labelledby="ad-jobs">
          <div className="sect">
            <h2 id="ad-jobs">Job</h2>
            <div className="r">
              <Link to="/admin/jobs" search={{}} className="btn">
                Mọi job lỗi
              </Link>
            </div>
          </div>
          <dl className="props compact">
            <dt>Đang chạy</dt>
            <dd className="num">{o.jobs.running}</dd>
            <dt>Thất bại</dt>
            <dd className="num">{o.jobs.failed}</dd>
            <dt>Dọn chưa hết</dt>
            <dd className="num">{o.jobs.compensationFailed}</dd>
            <dt>Đang hủy</dt>
            <dd className="num">{o.jobs.cancelRequested}</dd>
          </dl>
          <RecentFailedJobs />
        </section>

        <section aria-labelledby="ad-clouds">
          <div className="sect">
            <h2 id="ad-clouds">Project theo cloud</h2>
          </div>
          {o.clouds.length === 0 ? (
            <p className="c3">Chưa project nào kết nối cloud.</p>
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
              {o.orphans.count} tài nguyên mồ côi đang tốn{" "}
              {formatUsd(o.orphans.usdPerHour)} mỗi giờ trên cloud của khách.{" "}
              <Link to="/admin/orphans">Xem tài nguyên mồ côi</Link>
            </p>
          )}
        </section>
      </div>

      <section aria-labelledby="ad-tools">
        <div className="sect">
          <h2 id="ad-tools">Công cụ được bật nhiều nhất</h2>
          <div className="r">
            <Link to="/admin/catalog" className="btn">
              Catalog domain
            </Link>
          </div>
        </div>
        {o.tools.length === 0 ? (
          <p className="c3">Chưa project nào bật domain.</p>
        ) : (
          <table className="dtable" aria-labelledby="ad-tools">
            <thead>
              <tr>
                <th scope="col">Công cụ</th>
                <th scope="col">Domain</th>
                <th scope="col" className="num">
                  Project
                </th>
                <th scope="col">
                  <span className="visually-hidden">Tỉ lệ</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {o.tools.map((t) => (
                <tr key={`${t.domainType}:${t.toolId}`}>
                  <td className="mono" translate="no">
                    {t.toolId}
                  </td>
                  <td className="mono c3" translate="no">
                    {t.domainType}
                  </td>
                  <td className="num">{t.projects}</td>
                  <td className="tool-bar">
                    <i
                      style={{
                        transform: `scaleX(${String(t.projects / toolMax)})`,
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
  if (recent.length === 0) return <p className="c3">Không có job thất bại.</p>;
  return (
    <ul className="lst" aria-label="Job thất bại gần nhất">
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
