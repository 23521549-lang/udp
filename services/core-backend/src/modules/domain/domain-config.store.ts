import { Prisma } from "@udp/db";
import { capabilityPreferenceSchema } from "@udp/shared-types/domain-api";
import type {
  ProjectDomainWire,
  ProjectDomainsResponseWire,
} from "@udp/shared-types/wire";
import { prisma } from "../../core/db.js";
import type { ResolvedTarget } from "./domain-target.js";

/**
 * `domain_configs` + `capability_preferences` + `projects.domain_set_version` của MỘT
 * project (§2.2). Service 1 là writer của cả ba (ma trận I22).
 */

const CONFIG_FIELDS = {
  domainType: true,
  isEnabled: true,
  selectedTool: true,
  toolConfig: true,
  domainStatus: true,
  adapterVersion: true,
  updatedAt: true,
  lastError: true,
} as const satisfies Prisma.DomainConfigSelect;

type ConfigRow = Prisma.DomainConfigGetPayload<{
  select: typeof CONFIG_FIELDS;
}>;

const objectOrNull = (v: unknown): Record<string, unknown> | null =>
  typeof v === "object" && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;

function domainView(
  domainType: string,
  row: ConfigRow | undefined,
): ProjectDomainWire {
  return {
    domainType,
    isEnabled: row?.isEnabled ?? false,
    selectedTool: row?.selectedTool ?? null,
    toolConfig: objectOrNull(row?.toolConfig),
    status: row?.domainStatus ?? null,
    adapterVersion: row?.adapterVersion ?? null,
    updatedAt: row?.updatedAt.toISOString() ?? null,
  };
}

export interface ProjectDomainState {
  status: string;
  view: ProjectDomainsResponseWire;
}

/**
 * Mọi domain của catalog, theo thứ tự hiển thị — domain chưa từng cấu hình vẫn có một mục
 * (`status: null`): Portal vẽ đủ 16 hàng mà không phải tự ghép catalog với cấu hình.
 */
export async function projectDomains(
  projectId: string,
): Promise<ProjectDomainState | null> {
  const [project, catalog, rows, preferences] = await Promise.all([
    prisma.project.findUnique({
      where: { id: projectId },
      select: { status: true, domainSetVersion: true },
    }),
    prisma.domainCatalog.findMany({
      orderBy: [{ tier: "asc" }, { defaultOrder: "asc" }],
      select: { domainType: true },
    }),
    prisma.domainConfig.findMany({
      where: { projectId },
      select: CONFIG_FIELDS,
    }),
    prisma.capabilityPreference.findMany({
      where: { projectId },
      orderBy: { capabilityId: "asc" },
      select: { capabilityId: true, providerToolId: true },
    }),
  ]);
  if (project === null) return null;
  const byType = new Map(rows.map((r) => [r.domainType, r]));
  return {
    status: project.status,
    view: {
      domainSetVersion: project.domainSetVersion,
      domains: catalog.map((c) =>
        domainView(c.domainType, byType.get(c.domainType)),
      ),
      // Parse qua CÙNG schema của lần ghi: một hàng mang capability lạ là dữ liệu hỏng, nói ra
      preferences: preferences.map((p) => capabilityPreferenceSchema.parse(p)),
    },
  };
}

export async function domainRow(
  projectId: string,
  domainType: string,
): Promise<{ view: ProjectDomainWire; lastError: unknown } | null> {
  const [known, row] = await Promise.all([
    prisma.domainCatalog.findUnique({
      where: { domainType },
      select: { domainType: true },
    }),
    prisma.domainConfig.findUnique({
      where: { projectId_domainType: { projectId, domainType } },
      select: CONFIG_FIELDS,
    }),
  ]);
  if (known === null) return null;
  return {
    view: domainView(domainType, row ?? undefined),
    lastError: row?.lastError,
  };
}

/** `domain_type → is_available` của catalog — domain đã gỡ không được bật lại */
export async function catalogAvailability(): Promise<Map<string, boolean>> {
  const rows = await prisma.domainCatalog.findMany({
    select: { domainType: true, isAvailable: true },
  });
  return new Map(rows.map((r) => [r.domainType, r.isAvailable]));
}

export type ReplaceOutcome = "saved" | "stale-version" | "not-draft";

/**
 * Ghi CẢ TẬP trong một transaction (§2.2 `domain_set_version`, Plan #27 QĐ-4).
 *
 * Bước đầu là UPDATE có điều kiện `version = lastKnown AND status = DRAFT`: đó là khoá —
 * hai PUT đua nhau cùng mang một version thì đúng một cái đổi được hàng, cái kia thấy 0
 * và KHÔNG ghi gì. Kiểm-rồi-ghi ở ngoài transaction là mở một cửa sổ đua giữa hai bước.
 */
export async function replaceDomains(args: {
  projectId: string;
  lastKnownVersion: number;
  targets: readonly ResolvedTarget[];
  preferences: readonly { capabilityId: string; providerToolId: string }[];
  audit: Omit<Prisma.AuditLogUncheckedCreateInput, "projectId">;
}): Promise<ReplaceOutcome> {
  return prisma.$transaction(async (tx) => {
    const bumped = await tx.project.updateMany({
      where: {
        id: args.projectId,
        domainSetVersion: args.lastKnownVersion,
        status: "DRAFT",
      },
      data: { domainSetVersion: { increment: 1 } },
    });
    if (bumped.count === 0) {
      const current = await tx.project.findUnique({
        where: { id: args.projectId },
        select: { status: true },
      });
      return current?.status === "DRAFT" ? "stale-version" : "not-draft";
    }

    for (const t of args.targets) {
      const data = {
        isEnabled: true,
        selectedTool: t.adapter.toolId,
        toolConfig: t.config as Prisma.InputJsonValue,
        adapterVersion: t.adapter.version,
        // Project nháp: chưa triển khai gì, mọi domain bật là chờ (§8.1)
        domainStatus: "PENDING" as const,
      };
      await tx.domainConfig.upsert({
        where: {
          projectId_domainType: {
            projectId: args.projectId,
            domainType: t.domainType,
          },
        },
        create: {
          projectId: args.projectId,
          domainType: t.domainType,
          ...data,
        },
        update: data,
      });
    }
    // Domain vắng mặt trong trạng thái đích là TẮT; giữ lại tool và cấu hình cũ để bật lại
    await tx.domainConfig.updateMany({
      where: {
        projectId: args.projectId,
        isEnabled: true,
        domainType: { notIn: args.targets.map((t) => t.domainType) },
      },
      data: { isEnabled: false },
    });

    await tx.capabilityPreference.deleteMany({
      where: { projectId: args.projectId },
    });
    if (args.preferences.length > 0) {
      await tx.capabilityPreference.createMany({
        data: args.preferences.map((p) => ({
          projectId: args.projectId,
          ...p,
        })),
      });
    }
    await tx.auditLog.create({
      data: { ...args.audit, projectId: args.projectId },
    });
    return "saved";
  });
}
