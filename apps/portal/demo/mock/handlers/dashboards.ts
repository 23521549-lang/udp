import type {
  AdminOverviewWire,
  AdminPlatformWire,
  ArchitectureToolWire,
  ArchitectureWire,
  DomainCatalogEntryWire,
  HomeWire,
  MonitoringConsoleWire,
  RedMetricsWire,
  RedRange,
} from "@udp/shared-types/wire";
import { RED_RANGES } from "@udp/shared-types/wire";
import { iso, nowIso, OPENED_AT } from "../clock";
import type { Db, ProjectRecord } from "../db";
import { golden } from "../goldens";
import { prng, type Rng } from "../random";
import { found, HttpProblem, ok, projectOf, type Router } from "../router";
import { orphansOf } from "./auth-admin";

/**
 * [Plan #53] Các màn tổng hợp: trang chủ developer (QĐ-5), sơ đồ kiến trúc (QĐ-3), request/lỗi/độ trễ theo
 * thời gian (QĐ-4), và hai trang tổng quan của Bảng điều khiển (QĐ-6). Mọi con số tính TỪ "database" của bản
 * xem thử — bật một domain hay duyệt một deploy là thấy đổi ở đây — và chuỗi thời gian là ngẫu nhiên TẤT ĐỊNH
 * theo workload, nên mở lại trang vẫn cùng hình.
 */

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

const CATALOG = golden<{ domains: DomainCatalogEntryWire[] }>(
  "GET /domains/catalog",
).domains;

/** Project người xem là thành viên — cùng tập với `GET /projects` */
const mine = (db: Db): ProjectRecord[] =>
  db.projects.filter((p) => !p.adminOnly && p.project.status !== "DELETED");

// ------------------------------------------------------------------ trang chủ

type Attention = HomeWire["attention"][number];

const envRef = (p: ProjectRecord, envId: string) => {
  const e = found(
    p.environments.find((x) => x.id === envId),
    "environment",
  );
  return { id: e.id, name: e.name, isProduction: e.isProduction };
};

/** Việc cần xử lý của MỘT project — cùng sáu loại, cùng nguồn với `home.service` của Service 1 */
function attentionOf(p: ProjectRecord): Attention[] {
  const base = { projectId: p.project.id, projectName: p.project.name };
  const out: Attention[] = [];
  for (const [envId, list] of Object.entries(p.deployments)) {
    for (const d of list) {
      if (d.status !== "DEPLOY_PENDING") continue;
      out.push({
        ...base,
        kind: "DEPLOY_PENDING",
        subject: d.workloadName ?? "deploy",
        environment: envRef(p, envId),
        refId: d.deploymentId,
        at: d.lastEventAt,
      });
    }
  }
  for (const d of p.domains.domains) {
    if (!d.isEnabled) continue;
    const at = d.updatedAt ?? p.project.createdAt;
    if (d.status === "ERROR" || d.status === "BLOCKED") {
      out.push({
        ...base,
        kind: "DOMAIN_ERROR",
        subject: d.domainType,
        environment: null,
        refId: null,
        at,
      });
      continue;
    }
    const drift = p.domains.drift[d.domainType];
    if (drift?.verdict === "DRIFTED") {
      out.push({
        ...base,
        kind: "DOMAIN_DRIFTED",
        subject: d.domainType,
        environment: null,
        refId: null,
        at: drift.at ?? at,
      });
    }
  }
  const latestJob = [...p.jobs]
    .map((j) => j.detail.job)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  if (
    latestJob !== undefined &&
    (latestJob.state === "FAILED" || latestJob.state === "COMPENSATION_FAILED")
  ) {
    out.push({
      ...base,
      kind: "JOB_FAILED",
      subject: latestJob.jobType,
      environment: null,
      refId: latestJob.id,
      at: latestJob.updatedAt,
    });
  }
  const expires = p.project.expiresAt;
  if (expires !== null && Date.parse(expires) - Date.now() < 48 * HOUR) {
    out.push({
      ...base,
      kind: "PROJECT_EXPIRING",
      subject: p.project.name,
      environment: null,
      refId: null,
      at: expires,
    });
  }
  for (const r of p.rollouts) {
    if (r.status !== "PAUSED") continue;
    out.push({
      ...base,
      kind: "ROLLOUT_PAUSED",
      subject: r.flag?.key ?? r.workloadName ?? "rollout",
      environment: r.environment,
      refId: r.id,
      at: r.updatedAt,
    });
  }
  return out;
}

const HOME_DEPLOY_DAYS = 14;

function homeOf(db: Db): HomeWire {
  const projects = mine(db);
  const attention = projects
    .flatMap(attentionOf)
    .sort((a, b) => b.at.localeCompare(a.at));
  const rollouts = projects
    .flatMap((p) =>
      p.rollouts
        .filter(
          (r) =>
            r.status === "IN_PROGRESS" ||
            r.status === "PAUSED" ||
            r.status === "PENDING",
        )
        .map((r) => ({
          id: r.id,
          projectId: p.project.id,
          projectName: p.project.name,
          environment: r.environment,
          subject: r.flag?.key ?? r.workloadName ?? "rollout",
          scope: r.scope,
          status: r.status as "PENDING" | "IN_PROGRESS" | "PAUSED",
          trafficPercentage: r.currentTrafficPercentage,
          updatedAt: r.updatedAt,
        })),
    )
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, 20);

  const today = Date.parse(`${nowIso().slice(0, 10)}T00:00:00Z`);
  const days = Array.from({ length: HOME_DEPLOY_DAYS }, (_, i) =>
    iso(today - (HOME_DEPLOY_DAYS - 1 - i) * DAY).slice(0, 10),
  );
  const count = new Map(days.map((d) => [d, { success: 0, failure: 0 }]));
  for (const p of projects) {
    for (const list of Object.values(p.deployments)) {
      for (const d of list) {
        const slot = count.get(d.lastEventAt.slice(0, 10));
        if (slot === undefined) continue;
        if (d.status === "DEPLOY_SUCCESS") slot.success += 1;
        if (d.status === "DEPLOY_FAILURE") slot.failure += 1;
      }
    }
  }

  return {
    projects: projects.map((p) => ({
      id: p.project.id,
      name: p.project.name,
      status: p.project.status,
      myRole: p.project.myRole,
      cloudProvider: p.cloud?.provider ?? null,
      environmentCount: p.environments.length,
      expiresAt: p.project.expiresAt,
      activeRollouts: p.rollouts.filter(
        (r) => r.status === "IN_PROGRESS" || r.status === "PAUSED",
      ).length,
      attention: attentionOf(p).length,
    })),
    rollouts,
    attention,
    deploys: days.map((date) => ({
      date,
      ...(count.get(date) ?? { success: 0, failure: 0 }),
    })),
    generatedAt: nowIso(),
  };
}

// ------------------------------------------------------------------ kiến trúc

type CatalogTool = DomainCatalogEntryWire["tools"][number];
type Requirement = CatalogTool["requires"][number];

interface Enabled {
  key: string;
  entry: DomainCatalogEntryWire;
  tool: CatalogTool;
  domain: ProjectRecord["domains"]["domains"][number];
}

function enabledTools(p: ProjectRecord): Enabled[] {
  return p.domains.domains.flatMap((domain) => {
    if (!domain.isEnabled || domain.selectedTool === null) return [];
    const entry = CATALOG.find((e) => e.domainType === domain.domainType);
    const tool = entry?.tools.find((t) => t.toolId === domain.selectedTool);
    if (entry === undefined || tool === undefined) return [];
    return [
      {
        key: `${domain.domainType.toLowerCase()}:${tool.toolId}`,
        entry,
        tool,
        domain,
      },
    ];
  });
}

/**
 * Cạnh tiêu thụ → cung cấp, như `capabilityEdges` của resolver: capability có preference thì theo preference,
 * `anyOf` lấy nhánh đầu tiên có người cung cấp.
 */
function edgesOf(
  p: ProjectRecord,
  tools: Enabled[],
): ArchitectureWire["edges"] {
  const providerOf = (
    capabilityId: string,
    self: string,
  ): string | undefined => {
    const preferred = p.domains.preferences.find(
      (x) => x.capabilityId === capabilityId,
    )?.providerToolId;
    const candidates = tools.filter(
      (t) =>
        t.key !== self && t.tool.provides.some((c) => c.id === capabilityId),
    );
    return (
      candidates.find((t) => t.key === preferred)?.key ?? candidates[0]?.key
    );
  };
  const out: ArchitectureWire["edges"] = [];
  const add = (from: string, req: Requirement): void => {
    const options = "anyOf" in req ? req.anyOf : [req];
    for (const option of options) {
      const to = providerOf(option.id, from);
      if (to === undefined) continue;
      out.push({ from, to, capabilityId: option.id });
      return;
    }
  };
  for (const t of tools) for (const req of t.tool.requires) add(t.key, req);
  return out;
}

/** Bậc deploy = độ dài đường phụ thuộc dài nhất (công cụ không cần ai ở bậc 0) */
function tiersOf(
  tools: Enabled[],
  edges: ArchitectureWire["edges"],
): Map<string, number> {
  const tier = new Map<string, number>();
  const visit = (key: string, depth: number): number => {
    const known = tier.get(key);
    if (known !== undefined) return known;
    if (depth > tools.length) return 0;
    const deps = edges.filter((e) => e.from === key).map((e) => e.to);
    const value =
      deps.length === 0
        ? 0
        : 1 + Math.max(...deps.map((d) => visit(d, depth + 1)));
    tier.set(key, value);
    return value;
  };
  for (const t of tools) visit(t.key, 0);
  return tier;
}

function architectureOf(p: ProjectRecord): ArchitectureWire {
  const tools = enabledTools(p);
  const edges = edgesOf(p, tools);
  const tiers = tiersOf(tools, edges);
  const seen = new Set<string>();
  const resources = p.jobs.flatMap(({ detail }) =>
    detail.resources.flatMap((r) => {
      const key = `${r.step}:${r.name}`;
      if (r.status === "DELETED" || seen.has(key)) return [];
      seen.add(key);
      return [{ step: r.step, kind: r.kind, name: r.name, status: r.status }];
    }),
  );
  return {
    cloud:
      p.cloud === null
        ? null
        : {
            provider: p.cloud.provider,
            region: p.cloud.region,
            mode: p.cloud.mode,
            authKind: p.cloud.authKind,
            lastValidatedAt: p.cloud.lastValidatedAt,
          },
    cluster:
      p.cluster === null
        ? null
        : {
            clusterId: p.cluster.clusterId,
            apiEndpoint: p.cluster.apiEndpoint,
          },
    resources,
    environments: [...p.environments]
      .sort((a, b) => a.rank - b.rank)
      .map((e) => ({
        id: e.id,
        name: e.name,
        namespace: e.k8sNamespace,
        isProduction: e.isProduction,
        workloads: workloadsOf(p, e.id).map((d) => ({
          name: d.workloadName ?? "workload",
          imageTag: d.imageTag,
          commitSha: d.commitSha,
          lastEvent:
            d.status as ArchitectureWire["environments"][number]["workloads"][number]["lastEvent"],
          at: d.lastEventAt,
        })),
      })),
    tools: tools.map((t): ArchitectureToolWire => ({
      key: t.key,
      domainType: t.entry.domainType,
      displayName: t.entry.displayName,
      toolId: t.tool.toolId,
      adapterVersion: t.domain.adapterVersion,
      scope: t.tool.scope,
      tier: tiers.get(t.key) ?? null,
      status: t.domain.status,
      drift: {
        verdict: p.domains.drift[t.entry.domainType]?.verdict ?? "CLEAN",
        at: p.domains.drift[t.entry.domainType]?.at ?? null,
      },
      provides: t.tool.provides.map((c) => c.id),
    })),
    edges,
    valid: true,
    generatedAt: nowIso(),
  };
}

/** Bản gần nhất của mỗi workload ở một env (deploy mới nhất trước) — không có bảng workload nào khác */
function workloadsOf(p: ProjectRecord, envId: string) {
  const latest = new Map<
    string,
    ProjectRecord["deployments"][string][number]
  >();
  for (const d of p.deployments[envId] ?? []) {
    if (d.workloadName === null || d.status === "FLAG_CHANGE") continue;
    if (!latest.has(d.workloadName)) latest.set(d.workloadName, d);
  }
  return [...latest.values()];
}

// ------------------------------------------------------------------ giám sát RED

/** Cửa sổ và bước của Service 1 (`RED_WINDOWS`): ≤ 169 điểm */
const RED_WINDOWS: Record<RedRange, { seconds: number; step: number }> = {
  "1h": { seconds: 3_600, step: 60 },
  "6h": { seconds: 21_600, step: 300 },
  "24h": { seconds: 86_400, step: 900 },
  "7d": { seconds: 604_800, step: 3_600 },
};

const PROVIDER_ID: Record<string, string> = {
  "prometheus-grafana": "prometheus",
  "victoria-metrics": "prometheus",
  "grafana-cloud": "prometheus",
  datadog: "datadog",
  newrelic: "newrelic",
  dynatrace: "dynatrace",
};

function consoleFor(toolId: string): MonitoringConsoleWire | null {
  switch (toolId) {
    case "prometheus-grafana":
      return {
        kind: "portForward",
        app: "grafana",
        command:
          "kubectl -n udp-system port-forward svc/udp-prometheus-grafana 3000:80",
        localUrl: "http://localhost:3000",
      };
    case "victoria-metrics":
      return {
        kind: "portForward",
        app: "query-ui",
        command:
          "kubectl -n udp-system port-forward svc/udp-victoria-metrics 8428:8428",
        localUrl: "http://localhost:8428/vmui",
      };
    case "datadog":
      return {
        kind: "url",
        app: "datadog",
        url: "https://app.datadoghq.com",
      };
    case "newrelic":
      return {
        kind: "url",
        app: "newrelic",
        url: "https://one.newrelic.com",
      };
    case "dynatrace":
      return {
        kind: "url",
        app: "dynatrace",
        url: "https://abc12345.live.dynatrace.com",
      };
    default:
      return null;
  }
}

/** FNV-1a — hạt giống tất định cho chuỗi của một workload */
function seedOf(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * Chuỗi RED của một workload: lưu lượng theo nhịp ngày (thấp lúc 3 giờ sáng, cao buổi tối), lỗi nền nhỏ cộng một
 * đợt tăng ở workload "không may", độ trễ bám theo tải. Vài điểm KHÔNG CÓ DỮ LIỆU (`null`, I7) — scrape trượt —
 * để biểu đồ cho thấy đường đứt thay vì một điểm 0 giả.
 */
function redSeries(
  rng: Rng,
  start: number,
  step: number,
  points: number,
  scale: number,
  unlucky: boolean,
) {
  const base = 6 + rng() * 40;
  const gapAt = new Set(
    Array.from({ length: 2 }, () => Math.floor(rng() * points)),
  );
  const spikeAt = Math.floor(points * (0.55 + rng() * 0.3));
  const spikeLen = Math.max(2, Math.round(points / 18));
  const requestRate: (number | null)[] = [];
  const errorRatio: (number | null)[] = [];
  const latencyP99Ms: (number | null)[] = [];
  // Lỗi và độ trễ trôi dần (trung bình trượt) chứ không nhảy từng điểm: đường của số đo thật
  let errDrift = 0.003;
  let latDrift = 20;
  for (let i = 0; i < points; i++) {
    if (gapAt.has(i)) {
      requestRate.push(null);
      errorRatio.push(null);
      latencyP99Ms.push(null);
      continue;
    }
    const hour = new Date(start + i * step * 1000).getUTCHours() + 7;
    const daily = 0.55 + 0.45 * Math.sin(((hour - 9) / 24) * 2 * Math.PI);
    const rps = base * scale * daily * (0.9 + rng() * 0.2);
    const spiking = unlucky && i >= spikeAt && i < spikeAt + spikeLen;
    errDrift = 0.8 * errDrift + 0.2 * (0.001 + rng() * 0.004);
    latDrift = 0.8 * latDrift + 0.2 * (rng() * 40);
    const err = spiking ? 0.028 + rng() * 0.012 : errDrift;
    requestRate.push(Math.round(rps * 100) / 100);
    errorRatio.push(Math.round(err * 10_000) / 10_000);
    latencyP99Ms.push(
      Math.round(140 + daily * 90 + latDrift + (spiking ? 260 : 0)),
    );
  }
  return { requestRate, errorRatio, latencyP99Ms };
}

const MAX_RED_WORKLOADS = 12;

function redOf(
  p: ProjectRecord,
  envId: string,
  range: RedRange,
): RedMetricsWire {
  const env = found(
    p.environments.find((e) => e.id === envId),
    "environment",
  );
  const monitoring = p.domains.domains.find(
    (d) => d.domainType === "MONITORING" && d.isEnabled,
  );
  const toolId = monitoring?.selectedTool ?? null;
  if (toolId === null || p.cluster === null) {
    throw new HttpProblem(
      409,
      "METRICS_NOT_ENABLED",
      "Project chưa có nguồn metrics: bật domain Giám sát để thấy request, lỗi và độ trễ",
    );
  }
  const { seconds, step } = RED_WINDOWS[range];
  const points = seconds / step + 1;
  const end = Math.floor(Date.now() / (step * 1000)) * step * 1000;
  const start = end - seconds * 1000;
  const scale = env.isProduction ? 1 : env.name === "staging" ? 0.18 : 0.05;
  const workloads = workloadsOf(p, envId)
    .slice(0, MAX_RED_WORKLOADS)
    .map((d, index) => {
      const name = d.workloadName ?? "workload";
      const rng = prng(seedOf(`${p.project.id}:${envId}:${name}:${range}`));
      return {
        workload: name,
        ...redSeries(
          rng,
          start,
          step,
          points,
          scale,
          index === 0 && env.isProduction,
        ),
      };
    });
  return {
    environmentId: env.id,
    range,
    stepSeconds: step,
    start: iso(start),
    points,
    source: {
      providerId: PROVIDER_ID[toolId] ?? "prometheus",
      tool: `monitoring:${toolId}`,
    },
    console: consoleFor(toolId),
    workloads,
  };
}

// ------------------------------------------------------------------ Bảng điều khiển

const FAILED_STATES = new Set(["FAILED", "COMPENSATION_FAILED"]);

function adminOverviewOf(db: Db): AdminOverviewWire {
  const live = db.projects.filter((p) => p.project.status !== "DELETED");
  const byStatus = { DRAFT: 0, PROVISIONING: 0, ACTIVE: 0, ERROR: 0 };
  for (const p of live) {
    const s = p.project.status;
    if (s !== "DELETED") byStatus[s] += 1;
  }
  const clouds = new Map<"AWS" | "GCP" | "AZURE", number>();
  for (const p of live) {
    if (p.cloud !== null)
      clouds.set(p.cloud.provider, (clouds.get(p.cloud.provider) ?? 0) + 1);
  }
  const jobs = db.projects.flatMap((p) => p.jobs.map((j) => j.detail.job));
  const tools = new Map<
    string,
    { domainType: string; toolId: string; projects: number }
  >();
  for (const p of live) {
    for (const d of p.domains.domains) {
      if (!d.isEnabled || d.selectedTool === null) continue;
      const key = `${d.domainType}:${d.selectedTool}`;
      const row = tools.get(key) ?? {
        domainType: d.domainType,
        toolId: d.selectedTool,
        projects: 0,
      };
      row.projects += 1;
      tools.set(key, row);
    }
  }
  const since = Date.now() - 7 * DAY;
  let success = 0;
  let failure = 0;
  for (const p of live) {
    for (const list of Object.values(p.deployments)) {
      for (const d of list) {
        if (Date.parse(d.lastEventAt) < since) continue;
        if (d.status === "DEPLOY_SUCCESS") success += 1;
        if (d.status === "DEPLOY_FAILURE") failure += 1;
      }
    }
  }
  const orphans = orphansOf(db);
  return {
    users: {
      total: db.users.length,
      admins: db.users.filter((u) => u.platformRole === "PLATFORM_ADMIN")
        .length,
      newLast7d: db.users.filter((u) => Date.parse(u.createdAt) >= since)
        .length,
    },
    projects: { total: live.length, byStatus },
    clouds: [...clouds.entries()]
      .map(([provider, projects]) => ({ provider, projects }))
      .sort((a, b) => b.projects - a.projects),
    jobs: {
      running: jobs.filter(
        (j) => !FAILED_STATES.has(j.state) && j.state !== "DONE",
      ).length,
      failed: jobs.filter((j) => j.state === "FAILED").length,
      compensationFailed: jobs.filter((j) => j.state === "COMPENSATION_FAILED")
        .length,
      cancelRequested: jobs.filter((j) => j.state === "CANCEL_REQUESTED")
        .length,
    },
    orphans: {
      count: orphans.resources.length,
      usdPerHour: orphans.estimatedUsdPerHour,
      unpriced: orphans.unpriced.length,
    },
    tools: [...tools.values()]
      .sort(
        (a, b) => b.projects - a.projects || a.toolId.localeCompare(b.toolId),
      )
      .slice(0, 10),
    deploys7d: { success, failure },
    database: { sizeBytes: 412 * 1024 * 1024 + db.users.length * 18_432 },
    generatedAt: nowIso(),
  };
}

/**
 * Cụm chạy UDP của bản xem thử: máy ảo Oracle Always Free (A1, 2 OCPU, 12 GB) — đúng hình mà Plan #52 dựng.
 * CPU dao động nhẹ theo thời gian mở trang, để thanh mức dùng có sống.
 */
function platformOf(): AdminPlatformWire {
  const wobble = Math.sin((Date.now() - OPENED_AT) / 20_000) * 0.06;
  return {
    release: "c519f0c",
    node: {
      state: "ok",
      name: "udp-a1-hcm",
      cpuCores: 2,
      cpuUsedCores: Math.round((0.62 + wobble) * 100) / 100,
      memoryBytes: 12 * 1024 ** 3,
      memoryUsedBytes: Math.round(5.3 * 1024 ** 3),
    },
    postgresVolume: { state: "ok", capacityBytes: 20 * 1024 ** 3 },
    backup: {
      state: "ok",
      schedule: "30 19 * * *",
      lastScheduleAt: iso(OPENED_AT - 7 * HOUR),
      lastSuccessAt: iso(OPENED_AT - 7 * HOUR + 4 * 60_000),
      lastFailureAt: iso(OPENED_AT - 9 * DAY),
    },
    certificate: {
      state: "ok",
      name: "udp-tls",
      ready: true,
      notAfter: iso(OPENED_AT + 54 * DAY),
      issuer: "udp-letsencrypt",
    },
    checkedAt: nowIso(),
  };
}

const rangeOf = (raw: string | null): RedRange =>
  RED_RANGES.find((r) => r === raw) ?? "6h";

export function registerDashboardRoutes(router: Router, db: Db): void {
  router
    .on("GET", "/home", () => ok({ home: homeOf(db) }))
    .on("GET", "/projects/:id/architecture", (_req, [id = ""]) =>
      ok({ architecture: architectureOf(projectOf(db, id)) }),
    )
    .on("GET", "/projects/:id/metrics/red", (req, [id = ""]) =>
      ok({
        metrics: redOf(
          projectOf(db, id),
          req.query.get("envId") ?? "",
          rangeOf(req.query.get("range")),
        ),
      }),
    )
    .on("GET", "/admin/overview", () => ok({ overview: adminOverviewOf(db) }))
    .on("GET", "/admin/platform", () => ok({ platform: platformOf() }));
}
