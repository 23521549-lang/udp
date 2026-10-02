import { Prisma } from "@udp/db";
import type { CapabilityId } from "@udp/shared-types";
import {
  ARCHITECTURE_DEPLOY_DAYS,
  type ArchitectureWire,
} from "@udp/shared-types/wire";
import { z } from "zod";
import { prisma } from "../../core/db.js";
import {
  adapterKey,
  capabilityEdges,
  OrphanPreferenceError,
  validateAndOrder,
  type ResolvableAdapter,
  type ValidationResult,
} from "../capability/capability.resolver.js";
import { activeMeta } from "../cloud/cloud.repository.js";
import { dailyOutcomes, utcDayWindow } from "../deployment/deployment.dora.js";
import { eventsOfProject } from "../deployment/deployment.repository.js";
import type { DomainAdapterRegistry } from "../domain/domain-adapter.registry.js";
import { driftVerdictOf } from "../domain/project-domain.service.js";
import { clusterAccessOf } from "../project/project.repository.js";

/**
 * [v4.11, Plan #53 QĐ-3] Sơ đồ kiến trúc của MỘT project, ghép từ dữ liệu đã có — không bảng mới:
 *
 * - cloud: credential đang dùng; cluster: `cluster_access` (địa chỉ, không quyền vào);
 * - tài nguyên: sổ `provisioned_resources` còn sống trên cloud của khách;
 * - environment và workload: `environments` + bản gần nhất của từng workload trong
 *   `deployment_events` (§2.2 không có bảng workload nào khác — một workload tồn tại vì nó đã được
 *   deploy qua UDP);
 * - công cụ và cạnh: domain đang bật, qua CHÍNH `validateAndOrder` (bậc) và `capabilityEdges`
 *   (cạnh) — sơ đồ vẽ đúng đồ thị đã chặn cấu hình sai và đã sinh thứ tự deploy;
 * - deploy theo ngày [Plan #57]: CÙNG `dailyOutcomes` với E10 của trang Bằng chứng, trên mọi env.
 *
 * Chỉ ĐỌC database và registry trong bộ nhớ: không chạm cluster, không mở bí mật nào.
 */

const clusterAddress = z.object({
  clusterId: z.string().min(1),
  apiEndpoint: z.string().min(1),
});

const LIVE_RESOURCE = [
  "CREATING",
  "CREATED",
  "READY",
  "DELETING",
  "ORPHAN_SUSPECTED",
] as const;

type WorkloadEvent =
  ArchitectureWire["environments"][number]["workloads"][number]["lastEvent"];

interface WorkloadRow {
  environmentId: string;
  workloadName: string;
  eventType: WorkloadEvent;
  imageTag: string | null;
  commitSha: string | null;
  occurredAt: Date;
}

/**
 * Bản gần nhất của mỗi (environment, workload) — `DISTINCT ON` chạy trên index
 * `(project_id, environment_id, occurred_at DESC)`. `FLAG_CHANGE` không phải một lần deploy.
 */
export function latestWorkloads(projectId: string): Promise<WorkloadRow[]> {
  return prisma.$queryRaw<WorkloadRow[]>(Prisma.sql`
    SELECT DISTINCT ON (environment_id, workload_name)
      environment_id AS "environmentId",
      workload_name  AS "workloadName",
      event_type::text AS "eventType",
      image_tag      AS "imageTag",
      commit_sha     AS "commitSha",
      occurred_at    AS "occurredAt"
    FROM deployment_events
    WHERE project_id = ${projectId}::uuid
      AND workload_name IS NOT NULL
      AND event_type <> 'FLAG_CHANGE'
    -- [Plan #61, sua trong 61d-1] id DESC de DISTINCT ON co mot khoa sap TOAN PHAN: hai su kien cung moc thi
    -- Postgres duoc quyen giu hang nao cung duoc, va so do kien truc se hien eventType/imageTag khac nhau
    -- giua hai lan tai cung du lieu. id o day la khoa chot cho tinh xac dinh, khong phai mot dong ho.
    ORDER BY environment_id, workload_name, occurred_at DESC, id DESC`);
}

/** `{projectId}:{step}:{kind}:{name}` ⇒ `name` (tên có thể chứa `:` — giữ nguyên phần còn lại) */
const nameOfKey = (idempotencyKey: string): string =>
  idempotencyKey.split(":").slice(3).join(":") || idempotencyKey;

export async function projectArchitecture(
  projectId: string,
  registry: DomainAdapterRegistry,
  now: Date = new Date(),
): Promise<ArchitectureWire> {
  const deployWindow = utcDayWindow(ARCHITECTURE_DEPLOY_DAYS, now);
  const [
    meta,
    access,
    resources,
    environments,
    workloads,
    configs,
    catalog,
    prefs,
    events,
  ] = await Promise.all([
    activeMeta(projectId),
    clusterAccessOf(projectId),
    prisma.provisionedResource.findMany({
      where: { projectId, status: { in: [...LIVE_RESOURCE] } },
      select: { step: true, kind: true, idempotencyKey: true, status: true },
      orderBy: [{ step: "asc" }, { kind: "asc" }, { idempotencyKey: "asc" }],
    }),
    prisma.environment.findMany({
      where: { projectId },
      select: { id: true, name: true, k8sNamespace: true, isProduction: true },
      orderBy: { rank: "asc" },
    }),
    latestWorkloads(projectId),
    prisma.domainConfig.findMany({
      where: { projectId, isEnabled: true, selectedTool: { not: null } },
      select: {
        domainType: true,
        selectedTool: true,
        domainStatus: true,
        adapterVersion: true,
        lastError: true,
      },
    }),
    prisma.domainCatalog.findMany({
      select: { domainType: true, displayName: true, defaultOrder: true },
    }),
    prisma.capabilityPreference.findMany({
      where: { projectId },
      select: { capabilityId: true, providerToolId: true },
    }),
    eventsOfProject(projectId, deployWindow.from, deployWindow.to),
  ]);

  const catalogOf = new Map(catalog.map((c) => [c.domainType, c]));
  const enabled = configs
    .flatMap((c) =>
      c.selectedTool === null
        ? []
        : [
            {
              ...c,
              toolId: c.selectedTool,
              adapter: registry.get(c.domainType, c.selectedTool),
            },
          ],
    )
    .sort(
      (a, b) =>
        (catalogOf.get(a.domainType)?.defaultOrder ?? 0) -
        (catalogOf.get(b.domainType)?.defaultOrder ?? 0),
    );

  // Tool máy chủ không còn nạp vẫn lên sơ đồ (nó còn trên cluster), nhưng không vào resolver
  const resolvable: ResolvableAdapter[] = enabled.flatMap((t) =>
    t.adapter === undefined
      ? []
      : [
          {
            domainType: t.adapter.domainType,
            toolId: t.adapter.toolId,
            capabilities: t.adapter.capabilities,
          },
        ],
  );
  const result = resolveSafely(
    resolvable,
    prefs.map((p) => ({
      capabilityId: p.capabilityId as CapabilityId,
      providerToolId: p.providerToolId,
    })),
  );
  const tierOf = new Map(
    (result?.order ?? []).flatMap((tier, i) =>
      tier.map((k) => [k, i] as const),
    ),
  );

  const address = clusterAddress.safeParse(access);
  const byEnv = new Map<string, WorkloadRow[]>();
  for (const w of workloads) {
    byEnv.set(w.environmentId, [...(byEnv.get(w.environmentId) ?? []), w]);
  }

  return {
    cloud:
      meta === null
        ? null
        : {
            provider: meta.provider,
            region: meta.region,
            mode: meta.mode,
            authKind: meta.authKind,
            lastValidatedAt: meta.lastValidatedAt?.toISOString() ?? null,
          },
    cluster: address.success
      ? {
          clusterId: address.data.clusterId,
          apiEndpoint: address.data.apiEndpoint,
        }
      : null,
    resources: resources.map((r) => ({
      step: r.step,
      kind: r.kind,
      name: nameOfKey(r.idempotencyKey),
      status: r.status as (typeof LIVE_RESOURCE)[number],
    })),
    environments: environments.map((e) => ({
      id: e.id,
      name: e.name,
      namespace: e.k8sNamespace,
      isProduction: e.isProduction,
      workloads: (byEnv.get(e.id) ?? [])
        .sort((a, b) => a.workloadName.localeCompare(b.workloadName))
        .map((w) => ({
          name: w.workloadName,
          imageTag: w.imageTag,
          commitSha: w.commitSha,
          lastEvent: w.eventType,
          at: w.occurredAt.toISOString(),
        })),
    })),
    tools: enabled.map((t) => {
      const key = `${t.domainType}:${t.toolId}`.toLowerCase();
      const drift = driftVerdictOf(t.domainStatus, t.lastError);
      return {
        key,
        domainType: t.domainType,
        displayName: catalogOf.get(t.domainType)?.displayName ?? t.domainType,
        toolId: t.toolId,
        adapterVersion: t.adapterVersion,
        scope: t.adapter?.scope ?? null,
        tier: tierOf.get(key) ?? null,
        status: t.domainStatus,
        drift: { verdict: drift.verdict, at: drift.at },
        provides: t.adapter?.capabilities.provides.map((p) => p.id) ?? [],
      };
    }),
    edges: result === null ? [] : capabilityEdges(resolvable, result.chosen),
    deploys: dailyOutcomes(events, deployWindow),
    valid: result !== null,
    generatedAt: now.toISOString(),
  };
}

/**
 * Kết quả của resolver khi tổ hợp đang bật HỢP LỆ; `null` khi không (lỗi hay preference mồ côi). Sơ
 * đồ vẫn hiện công cụ khi cấu hình đang lưu hỏng — nó chỉ không có bậc và không có cạnh, và `valid`
 * nói điều đó ra thay vì vẽ một đồ thị đoán.
 */
function resolveSafely(
  adapters: readonly ResolvableAdapter[],
  prefs: Parameters<typeof validateAndOrder>[1],
): ValidationResult | null {
  try {
    const known = new Set(adapters.map(adapterKey));
    const usable = (prefs ?? []).filter((p) => known.has(p.providerToolId));
    const result = validateAndOrder(adapters, usable);
    return result.valid ? result : null;
  } catch (e) {
    if (e instanceof OrphanPreferenceError) return null;
    throw e;
  }
}
