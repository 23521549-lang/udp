import { useQuery } from "@tanstack/react-query";
import type {
  AdminOverviewWire,
  AdminPlatformWire,
  AdminSystemWire,
} from "@udp/shared-types/wire";
import {
  Archive,
  Cloud,
  Code2,
  Container,
  Database,
  DatabaseBackup,
  Gauge,
  Globe,
  Layers,
  Server,
  Shield,
  Smartphone,
  Users,
  Workflow,
  type LucideIcon,
} from "lucide-react";
import { useState, type ReactNode } from "react";
import { DiagramBar } from "../../../components/DiagramBar";
import { Icon } from "../../../components/Icon";
import { LinkLayer } from "../../../components/LinkLayer";
import { Meter } from "../../../components/Meter";
import { StackedBar, type StackTone } from "../../../components/StackedBar";
import { StatusLabel, type Tone } from "../../../components/StatusLabel";
import { useMessages, type MessageBundle } from "../../../i18n";
import { formatBytes, formatNumber } from "../../../lib/format";
import { qk } from "../../../lib/query-keys";
import { PROVIDER_LABEL } from "../../project/cloud/cloud-labels";
import { projectStatusMessages } from "../../project/project-status.messages";
import { AdminPage } from "../AdminLayout";
import { adminApi } from "../admin-api";
import { adminMessages } from "../admin.messages";
import {
  PLATFORM_LINKS,
  PLATFORM_NODES,
  serviceState,
  type PlatformNode,
} from "../platform-architecture";
import {
  backupVerdict,
  certificateVerdict,
  platformReason,
  serviceStatus,
} from "../platform-model";

/**
 * [Plan #57 QĐ-7] Kiến trúc của CHÍNH nền tảng UDP: máy ảo Oracle Always Free chạy k3s với sáu khối, những hệ bên
 * ngoài nối vào hay được gọi ra, cạnh ghi giao thức, sức khoẻ sống và ngân sách của máy. Không route mới: ba nguồn
 * sẵn có (`/admin/system/health`, `/admin/platform`, `/admin/overview`) tải và báo lỗi riêng — một nguồn hỏng chỉ
 * làm khối của nó thành "Không rõ".
 */

const ICON: Record<PlatformNode, LucideIcon> = {
  developer: Users,
  publisher: Shield,
  sdk: Smartphone,
  objectStorage: Archive,
  portal: Globe,
  s1: Server,
  s2: Layers,
  s3: Workflow,
  pg: Database,
  backup: DatabaseBackup,
  ci: Code2,
  clouds: Cloud,
  prometheus: Gauge,
  clusters: Container,
};

const CLOUD_TONES: readonly StackTone[] = ["accent", "c3", "c4", "neutral"];

/** Tên là định danh (tên service trong cụm): chữ đơn cách, không dịch */
const IDENTIFIER = new Set<PlatformNode>(["s1", "s2", "s3"]);

type Copy = (typeof adminMessages extends MessageBundle<infer V>
  ? V
  : never)["architecture"];

interface Health {
  tone: Tone;
  label: string;
}

export function AdminArchitecturePage() {
  const m = useMessages(adminMessages).architecture;
  const [asTable, setAsTable] = useState(false);
  const overview = useQuery({
    queryKey: qk.adminOverview(),
    queryFn: adminApi.overview,
    refetchInterval: 60_000,
  });
  const platform = useQuery({
    queryKey: qk.adminPlatform(),
    queryFn: adminApi.platform,
    refetchInterval: 30_000,
  });
  const system = useQuery({
    queryKey: qk.adminSystem(),
    queryFn: adminApi.system,
    refetchInterval: 30_000,
  });
  const health = useHealth(
    system.data,
    system.isPending,
    platform.data?.platform,
  );
  const o = overview.data?.overview;

  return (
    <AdminPage title={m.title} lead={m.lead}>
      {o !== undefined && <PlatformKpis overview={o} />}
      <DiagramBar
        solid={m.legend.solid}
        dashed={m.legend.dashed}
        note={m.legend.note}
        asTable={asTable}
        onToggle={() => setAsTable((v) => !v)}
      />
      {asTable ? (
        <PlatformTables health={health} overview={o} />
      ) : (
        <PlatformMap
          health={health}
          platform={platform.data?.platform}
          overview={o}
        />
      )}
    </AdminPage>
  );
}

/**
 * Sức khoẻ của sáu khối trong máy. Portal không có tín hiệu riêng — trang này do nó phục vụ — nên nó mang trạng thái
 * của chứng chỉ HTTPS mà người dùng đi qua để tới nó.
 */
function useHealth(
  system: AdminSystemWire | undefined,
  checking: boolean,
  platform: AdminPlatformWire | undefined,
): Partial<Record<PlatformNode, Health>> {
  const m = useMessages(adminMessages);
  const service = (state: "up" | "down" | "unknown"): Health =>
    checking
      ? { tone: "unknown", label: m.architecture.checking }
      : serviceStatus(state);
  const certificate = platform?.certificate;
  const backup = platform?.backup;
  return {
    portal:
      certificate === undefined
        ? { tone: "unknown", label: m.overview.unknown }
        : certificate.state === "unavailable"
          ? { tone: "unknown", label: platformReason(certificate.reason) }
          : (({ tone, label }) => ({
              tone,
              label: m.architecture.certificate(label),
            }))(certificateVerdict(certificate)),
    s1: service(serviceState(system, "s1")),
    s2: service(serviceState(system, "s2")),
    s3: service(serviceState(system, "s3")),
    pg: service(system?.database ?? "unknown"),
    backup:
      backup === undefined
        ? { tone: "unknown", label: m.overview.unknown }
        : backup.state === "unavailable"
          ? { tone: "unknown", label: platformReason(backup.reason) }
          : backupVerdict(backup),
  };
}

// ------------------------------------------------------------------ bốn con số

function PlatformKpis({ overview: o }: { overview: AdminOverviewWire }) {
  const t = useMessages(adminMessages);
  const m = t.architecture;
  const status = useMessages(projectStatusMessages).status;
  const byStatus = o.projects.byStatus;
  const deploys = o.deploys7d.success + o.deploys7d.failure;
  const clouds = o.clouds.reduce((n, c) => n + c.projects, 0);
  return (
    <section className="kpis sys-kpis" aria-label={m.kpi}>
      <div className="kpi">
        <div className="l">{t.overview.usersStat}</div>
        <div className="v num">{formatNumber(o.users.total)}</div>
        <div className="c3">
          {t.overview.usersSub(o.users.admins, o.users.newLast7d)}
        </div>
      </div>
      <div className="kpi">
        <div className="l">{t.overview.projectsStat}</div>
        <div className="v num">{formatNumber(o.projects.total)}</div>
        <StackedBar
          label={t.overview.projectsStat}
          format={formatNumber}
          parts={[
            {
              label: status.ACTIVE,
              value: byStatus.ACTIVE,
              tone: "accent",
            },
            {
              label: status.PROVISIONING,
              value: byStatus.PROVISIONING,
              tone: "c3",
            },
            {
              label: status.DRAFT,
              value: byStatus.DRAFT,
              tone: "neutral",
            },
            { label: status.ERROR, value: byStatus.ERROR, tone: "error" },
          ]}
        />
      </div>
      <div className="kpi">
        <div className="l">{t.overview.deploys}</div>
        <div className="v num">{formatNumber(deploys)}</div>
        <StackedBar
          label={t.overview.deploys}
          format={formatNumber}
          parts={[
            { label: m.success, value: o.deploys7d.success, tone: "neutral" },
            { label: m.failure, value: o.deploys7d.failure, tone: "error" },
          ]}
        />
      </div>
      <div className="kpi">
        <div className="l">{t.overview.byCloud}</div>
        <div className="v num">{formatNumber(clouds)}</div>
        {o.clouds.length === 0 ? (
          <div className="c3">{t.overview.noCloud}</div>
        ) : (
          <StackedBar
            label={t.overview.byCloud}
            format={formatNumber}
            parts={o.clouds.map((c, i) => ({
              label: PROVIDER_LABEL[c.provider],
              value: c.projects,
              tone: CLOUD_TONES[i % CLOUD_TONES.length] ?? "neutral",
            }))}
          />
        )}
      </div>
    </section>
  );
}

// ------------------------------------------------------------------ sơ đồ

/** Dòng phụ của một hệ bên ngoài — số của chính nền tảng khi có, không đoán khi chưa có */
function outsideNote(
  node: PlatformNode,
  o: AdminOverviewWire | undefined,
  m: Copy,
): string | undefined {
  switch (node) {
    case "sdk":
    case "objectStorage":
      return m.role[node];
    default:
      break;
  }
  if (o === undefined) return undefined;
  switch (node) {
    case "developer":
      return m.developers(o.users.total);
    case "publisher":
      return m.publishers(o.users.admins);
    case "ci":
      return m.ciDeploys(o.deploys7d.success + o.deploys7d.failure);
    case "clouds":
      return o.clouds.length === 0
        ? m.noCloud
        : o.clouds
            .map(
              (c) =>
                `${PROVIDER_LABEL[c.provider]} ${formatNumber(c.projects)}`,
            )
            .join(" · ");
    case "prometheus":
      return m.monitored(
        o.tools
          .filter((t) => t.domainType === "MONITORING")
          .reduce((n, t) => n + t.projects, 0),
      );
    case "clusters":
      return m.activeProjects(o.projects.byStatus.ACTIVE);
    default:
      return undefined;
  }
}

function NodeName({ id, copy }: { id: PlatformNode; copy: Copy }) {
  return IDENTIFIER.has(id) ? (
    <span className="mono" translate="no">
      {copy.node[id]}
    </span>
  ) : (
    <>{copy.node[id]}</>
  );
}

function PlatformMap({
  health,
  platform,
  overview,
}: {
  health: Partial<Record<PlatformNode, Health>>;
  platform: AdminPlatformWire | undefined;
  overview: AdminOverviewWire | undefined;
}) {
  const t = useMessages(adminMessages);
  const m = t.architecture;
  // Callback ref qua state: lớp cạnh đo SAU khi khung đã gắn (xem `LinkLayer`)
  const [root, setRoot] = useState<HTMLElement | null>(null);
  const [hover, setHover] = useState<string | undefined>(undefined);
  const node = platform?.node;
  const vmName = node?.state === "ok" ? node.name : undefined;

  const inside = (id: (typeof PLATFORM_NODES.vm)[number]) => {
    const h = health[id];
    return (
      <div
        key={id}
        className={`plat-card plat-${id} tone-${h?.tone ?? "unknown"}`}
        data-node={id}
        onMouseEnter={() => setHover(id)}
        onMouseLeave={() => setHover(undefined)}
      >
        <span className="sys-card-h">
          <Icon of={ICON[id]} />
          <b>
            <NodeName id={id} copy={m} />
          </b>
        </span>
        <span className="c3">{m.role[id]}</span>
        {h !== undefined && <StatusLabel tone={h.tone}>{h.label}</StatusLabel>}
      </div>
    );
  };
  const outside = (id: PlatformNode) => {
    const note = outsideNote(id, overview, m);
    return (
      <div
        key={id}
        className="sys-actor plat-ext"
        data-node={id}
        onMouseEnter={() => setHover(id)}
        onMouseLeave={() => setHover(undefined)}
      >
        <Icon of={ICON[id]} size={18} />
        <b>{m.node[id]}</b>
        {note !== undefined && <span className="c3">{note}</span>}
      </div>
    );
  };

  return (
    <div className="sys-scroll">
      <section
        className="plat-map"
        ref={setRoot}
        aria-label={vmName === undefined ? m.vmUnknown : m.vm(vmName)}
      >
        {/* Khung máy ảo: nền trang trí phủ ba cột giữa, các khối trong máy nằm trên nó */}
        <div className="plat-vm" aria-hidden="true" />
        <header className="plat-vm-h">
          <Icon of={Server} />
          <b className="mono" translate="no">
            {vmName ?? m.vmUnknown}
          </b>
          <span className="chip soft">{m.oracle}</span>
          {/* Máy không đọc được: khối ngân sách bên dưới nói lý do, đầu khung không nhắc lại */}
          {node?.state === "ok" && (
            <span className="chip soft">
              {t.overview.cores(node.cpuCores)} ·{" "}
              {formatBytes(node.memoryBytes)}
            </span>
          )}
          <span className="chip soft mono" translate="no">
            k3s
          </span>
          {platform?.release !== undefined && platform.release !== null && (
            <span className="chip soft mono" translate="no">
              {platform.release}
            </span>
          )}
          <span className="chip plat-free">{m.free}</span>
        </header>
        <div className="plat-left1">
          {outside("developer")}
          {outside("publisher")}
        </div>
        <div className="plat-left2">{outside("sdk")}</div>
        <div className="plat-left3">{outside("objectStorage")}</div>
        {PLATFORM_NODES.vm.map(inside)}
        <Budget platform={platform} overview={overview} />
        <div className="plat-right1">
          {outside("ci")}
          {outside("clouds")}
          {outside("prometheus")}
        </div>
        <div className="plat-right2">{outside("clusters")}</div>
        <LinkLayer
          container={root}
          links={PLATFORM_LINKS.map((l) => ({
            id: `${l.from}>${l.to}`,
            from: l.from,
            to: l.to,
            label: m.protocol[l.protocol],
            dashed: l.dashed,
            ...(l.under === true ? { axis: "under" as const } : {}),
          }))}
          active={hover}
          version={`${String(vmName)}:${String(overview?.generatedAt)}`}
          className="sys-links"
        />
      </section>
    </div>
  );
}

/** Ba thanh ngân sách của máy Always Free: CPU, RAM, ổ PostgreSQL — tín hiệu vắng thì nói lý do */
function Budget({
  platform,
  overview,
}: {
  platform: AdminPlatformWire | undefined;
  overview: AdminOverviewWire | undefined;
}) {
  const t = useMessages(adminMessages);
  const node = platform?.node;
  const volume = platform?.postgresVolume;
  const dbBytes = overview?.database.sizeBytes ?? null;
  const unknown = (text: string): ReactNode => (
    <StatusLabel tone="unknown">{text}</StatusLabel>
  );
  return (
    <section className="plat-budget" aria-labelledby="plat-budget-h">
      <h2 id="plat-budget-h" className="sys-zone-h">
        {t.architecture.budget}
      </h2>
      {node === undefined
        ? unknown(t.architecture.checking)
        : node.state === "unavailable"
          ? unknown(platformReason(node.reason))
          : [
              <Meter
                key="cpu"
                label="CPU"
                value={node.cpuUsedCores}
                max={node.cpuCores}
                format={t.overview.cores}
              />,
              <Meter
                key="ram"
                label="RAM"
                value={node.memoryUsedBytes}
                max={node.memoryBytes}
                format={formatBytes}
              />,
            ]}
      {volume === undefined ? null : volume.state === "unavailable" ? (
        unknown(platformReason(volume.reason))
      ) : dbBytes === null ? (
        <span className="c3">
          {t.overview.volumeOnly(formatBytes(volume.capacityBytes))}
        </span>
      ) : (
        <Meter
          label="PostgreSQL"
          value={dbBytes}
          max={volume.capacityBytes}
          format={formatBytes}
        />
      )}
    </section>
  );
}

// ------------------------------------------------------------------ bản bảng thay thế (QĐ-6)

function PlatformTables({
  health,
  overview,
}: {
  health: Partial<Record<PlatformNode, Health>>;
  overview: AdminOverviewWire | undefined;
}) {
  const m = useMessages(adminMessages).architecture;
  const rows: { id: PlatformNode; where: string }[] = [
    ...PLATFORM_NODES.vm.map((id) => ({ id, where: m.table.inVm })),
    ...[...PLATFORM_NODES.left, ...PLATFORM_NODES.right].map((id) => ({
      id,
      where: m.table.outside,
    })),
  ];
  return (
    <div className="sys-tables">
      <div className="table-wrap">
        <table className="dtable">
          <caption>{m.table.parts}</caption>
          <thead>
            <tr>
              <th scope="col">{m.table.part}</th>
              <th scope="col">{m.table.where}</th>
              <th scope="col">{m.table.role}</th>
              <th scope="col">{m.table.status}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(({ id, where }) => {
              const h = health[id];
              const note =
                id in m.role
                  ? m.role[id as keyof typeof m.role]
                  : outsideNote(id, overview, m);
              return (
                <tr key={id}>
                  <th scope="row">
                    <NodeName id={id} copy={m} />
                  </th>
                  <td>{where}</td>
                  <td>{note}</td>
                  <td>
                    {h !== undefined && (
                      <StatusLabel tone={h.tone}>{h.label}</StatusLabel>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="table-wrap">
        <table className="dtable">
          <caption>{m.table.links}</caption>
          <thead>
            <tr>
              <th scope="col">{m.table.from}</th>
              <th scope="col">{m.table.to}</th>
              <th scope="col">{m.table.protocol}</th>
              <th scope="col">{m.table.line}</th>
            </tr>
          </thead>
          <tbody>
            {PLATFORM_LINKS.map((l) => (
              <tr key={`${l.from}>${l.to}`}>
                <th scope="row">
                  <NodeName id={l.from} copy={m} />
                </th>
                <td>
                  <NodeName id={l.to} copy={m} />
                </td>
                <td>{m.protocol[l.protocol]}</td>
                <td className="c3">
                  {l.dashed ? m.legend.dashed : m.legend.solid}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
