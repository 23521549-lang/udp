import type { DomainAdapter } from "@udp/adapter-core";
import { isAnyOf } from "@udp/shared-types";
import type {
  DomainCatalogEntryWire,
  DomainToolWire,
} from "@udp/shared-types/wire";
import { prisma } from "../../core/db.js";
import { describeConfigSchema } from "./config-fields.js";
import type { DomainAdapterRegistry } from "./domain-adapter.registry.js";

/**
 * Danh mục domain cho Portal (§5.3, §9 "Domain — Catalog") — DỰNG TỪ REGISTRY: hàng của
 * `domain_catalog` cho tên, bậc, thứ tự và `is_available`; tool, phiên bản, capability và
 * trường cấu hình đọc thẳng từ adapter đã nạp. Không một danh sách cứng nào ở Service 1
 * hay Portal: thêm một thư mục adapter là nó hiện ở đây (I28 dương tính).
 */

export function toolView(adapter: DomainAdapter): DomainToolWire {
  const caps = adapter.capabilities;
  return {
    toolId: adapter.toolId,
    version: adapter.version,
    scope: adapter.scope,
    provides: caps.provides.map((p) => ({
      id: p.id,
      version: p.version,
      ...(p.exclusive === undefined ? {} : { exclusive: p.exclusive }),
    })),
    requires: caps.requires.map((r) =>
      isAnyOf(r)
        ? {
            anyOf: r.anyOf.map((a) => ({
              id: a.id,
              ...(a.constraint === undefined
                ? {}
                : { constraint: a.constraint }),
            })),
          }
        : {
            id: r.id,
            ...(r.constraint === undefined ? {} : { constraint: r.constraint }),
          },
    ),
    recommends: [...(caps.recommends ?? [])],
    conflicts: [...(caps.conflicts ?? [])],
    hints: Object.fromEntries(
      Object.entries(caps.hint ?? {}).filter(
        (e): e is [string, string] => typeof e[1] === "string",
      ),
    ),
    config: describeConfigSchema(adapter.configSchema),
  };
}

export async function buildCatalog(
  registry: DomainAdapterRegistry,
): Promise<DomainCatalogEntryWire[]> {
  const rows = await prisma.domainCatalog.findMany({
    orderBy: [{ tier: "asc" }, { defaultOrder: "asc" }],
  });
  const toolsByType = new Map<string, DomainToolWire[]>();
  for (const { adapter } of registry.all()) {
    const list = toolsByType.get(adapter.domainType) ?? [];
    list.push(toolView(adapter));
    toolsByType.set(adapter.domainType, list);
  }
  return rows.map((r) => ({
    domainType: r.domainType,
    tier: r.tier,
    displayName: r.displayName,
    defaultOrder: r.defaultOrder,
    isAvailable: r.isAvailable,
    tools: (toolsByType.get(r.domainType) ?? []).sort((a, b) =>
      a.toolId.localeCompare(b.toolId),
    ),
  }));
}
