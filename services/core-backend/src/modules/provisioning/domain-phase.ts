import type {
  ClusterAccess,
  DomainAdapter,
  DomainAdapterContext,
  ResourceQuota,
} from "@udp/adapter-core";
import type { Fence } from "@udp/adapter-core/runner";
import { Prisma, type DomainStatus, type PrismaClient } from "@udp/db";
import type { CapabilityBinding, CapabilityId } from "@udp/shared-types";
import {
  adapterKey,
  validateAndOrder,
} from "../capability/capability.resolver.js";
import {
  bindingRowOf,
  bindingsOfProject,
  deleteBindingsOfDomainConfig,
  upsertBinding,
  type StoredBinding,
} from "../capability/capability-binding.repository.js";
import { SYSTEM_NAMESPACE } from "../cluster/bootstrap.js";
import type { DomainAdapterRegistry } from "../domain/domain-adapter.registry.js";

/**
 * Pha DOMAINS của job PROVISION (§8.1, Plan #28 QĐ-5), và chiều ngược của nó khi bù trừ.
 *
 * Theo BẬC của `validateAndOrder`; các adapter cùng bậc chạy song song. Binding xuống bảng
 * ngay sau mỗi adapter, và `ctx.resolved` của bậc sau nạp lại TỪ BẢNG — worker chết giữa
 * hai bậc thì lượt sau đọc đúng endpoint mà bậc trước đã cung cấp, không từ bộ nhớ đã mất.
 *
 * Resume: domain đã `ACTIVE` ở đúng `adapter_version` thì bỏ qua (deploy idempotent, nhưng
 * chạm cluster lần hai không cho thêm gì). Một adapter thất bại ⇒ domain đó `ERROR`, các
 * domain ở bậc sau `BLOCKED` (nguyên nhân gốc nhìn thấy được thay vì một loạt lỗi giống
 * nhau), và pha trả `FAILED` cho job đi nhánh bù trừ.
 */

export interface PhaseEnvironment {
  id: string;
  name: string;
  k8sNamespace: string;
  isProduction: boolean;
}

export interface DomainPhaseInput {
  prisma: PrismaClient;
  projectId: string;
  registry: DomainAdapterRegistry;
  /** ClusterAccess dựng từ bound SA token — adapter không bao giờ thấy token admin */
  access: ClusterAccess;
  environments: readonly PhaseEnvironment[];
  region: string;
  quota: ResourceQuota;
  tags: Readonly<Record<string, string>>;
  /** Egress guard (§12 T11) — `ctx.fetch` của mọi adapter */
  fetch: typeof fetch;
  fence: Fence;
  progress: (message: string) => void;
}

export type DomainPhaseOutcome =
  | { status: "DONE"; deployed: string[] }
  | { status: "FAILED"; domainType: string; message: string };

interface EnabledDomain {
  id: string;
  domainType: string;
  adapter: DomainAdapter;
  config: Record<string, unknown>;
  alreadyActive: boolean;
}

interface Problem {
  domainType: string;
  message: string;
}

/** `last_error` của domain — cùng hình `{ step, message, adapterResult }` mà Portal đọc */
const lastErrorOf = (step: "DEPLOY" | "TEARDOWN", message: string) => ({
  step,
  message,
  adapterResult: "FAILED",
  at: new Date().toISOString(),
});

const messageOf = (e: unknown): string =>
  e instanceof Error ? e.message : String(e);

async function enabledDomains(
  input: DomainPhaseInput,
  statuses?: readonly DomainStatus[],
): Promise<EnabledDomain[] | Problem> {
  const rows = await input.prisma.domainConfig.findMany({
    where: {
      projectId: input.projectId,
      isEnabled: true,
      selectedTool: { not: null },
      ...(statuses === undefined
        ? {}
        : { domainStatus: { in: [...statuses] } }),
    },
    select: {
      id: true,
      domainType: true,
      selectedTool: true,
      toolConfig: true,
      domainStatus: true,
      adapterVersion: true,
    },
    orderBy: { domainType: "asc" },
  });
  const out: EnabledDomain[] = [];
  for (const r of rows) {
    const adapter = input.registry.get(r.domainType, r.selectedTool ?? "");
    if (adapter === undefined) {
      return {
        domainType: r.domainType,
        message: `không còn adapter ${String(r.selectedTool)} cho ${r.domainType}`,
      };
    }
    const parsed = adapter.configSchema.safeParse(r.toolConfig ?? {});
    if (!parsed.success) {
      return {
        domainType: r.domainType,
        message: `tool_config không còn khớp schema của ${adapterKey(adapter)}`,
      };
    }
    out.push({
      id: r.id,
      domainType: r.domainType,
      adapter,
      config: parsed.data as Record<string, unknown>,
      alreadyActive:
        r.domainStatus === "ACTIVE" && r.adapterVersion === adapter.version,
    });
  }
  return out;
}

/** Bậc deploy theo `validateAndOrder` trên CHÍNH tập domain và preference đang lưu */
async function tiersOf(
  input: DomainPhaseInput,
  domains: readonly EnabledDomain[],
): Promise<
  { tiers: EnabledDomain[][]; chosen: Record<string, string> } | Problem
> {
  const preferences = await input.prisma.capabilityPreference.findMany({
    where: { projectId: input.projectId },
    select: { capabilityId: true, providerToolId: true },
  });
  const validation = validateAndOrder(
    domains.map((d) => ({
      domainType: d.adapter.domainType,
      toolId: d.adapter.toolId,
      capabilities: d.adapter.capabilities,
    })),
    preferences.map((p) => ({
      capabilityId: p.capabilityId as CapabilityId,
      providerToolId: p.providerToolId,
    })),
  );
  if (!validation.valid || validation.order === null) {
    const first = validation.errors[0];
    return {
      domainType: first?.subject ?? "",
      message: `cấu hình domain không còn hợp lệ: ${String(first?.code)}`,
    };
  }
  const byKey = new Map(domains.map((d) => [adapterKey(d.adapter), d]));
  return {
    tiers: validation.order.map((tier) =>
      tier.flatMap((key) => byKey.get(key) ?? []),
    ),
    chosen: validation.chosen,
  };
}

/**
 * Binding mà một lần deploy nhìn thấy: provider ĐÃ CHỌN của từng capability, bản riêng của
 * environment thắng bản cluster-scoped.
 */
export function resolvedFor(
  stored: readonly StoredBinding[],
  chosen: Readonly<Record<string, string>>,
  environmentId: string | null,
): Partial<Record<CapabilityId, CapabilityBinding>> {
  const rank = (b: StoredBinding): number =>
    b.environmentId === null ? 1 : b.environmentId === environmentId ? 2 : 0;
  const best = new Map<string, StoredBinding>();
  for (const b of stored) {
    const want = chosen[b.capabilityId];
    if (rank(b) === 0 || (want !== undefined && want !== b.providedBy)) {
      continue;
    }
    const current = best.get(b.capabilityId);
    if (current === undefined || rank(b) > rank(current)) {
      best.set(b.capabilityId, b);
    }
  }
  const out: Partial<Record<CapabilityId, CapabilityBinding>> = {};
  for (const b of best.values()) {
    const id = b.capabilityId as CapabilityId;
    out[id] = {
      id,
      version: b.schemaVersion,
      providedBy: b.providedBy,
      ...(b.environmentId === null ? {} : { environmentId: b.environmentId }),
      ...(b.endpoint == null ? {} : { endpoint: b.endpoint }),
      ...(b.attributes == null ? {} : { attributes: b.attributes }),
    };
  }
  return out;
}

/** `scope = cluster` ⇒ một lần, không environment; `namespace` ⇒ mỗi environment một lần */
const targetsOf = (
  domain: EnabledDomain,
  environments: readonly PhaseEnvironment[],
): (PhaseEnvironment | undefined)[] =>
  domain.adapter.scope === "cluster" ? [undefined] : [...environments];

function contextFor(
  input: DomainPhaseInput,
  domain: EnabledDomain,
  env: PhaseEnvironment | undefined,
  resolved: Partial<Record<CapabilityId, CapabilityBinding>>,
): DomainAdapterContext {
  return {
    k8s: input.access,
    ...(env === undefined ? {} : { environment: env }),
    systemNamespace: SYSTEM_NAMESPACE,
    region: input.region,
    quota: input.quota,
    resolved,
    tags: input.tags,
    progress: (m) => {
      input.progress(`${domain.domainType}: ${m}`);
    },
    fetch: input.fetch,
  };
}

/** Deploy một domain lên mọi đích của nó; binding + `ACTIVE` ghi trong MỘT transaction */
async function deployOne(
  input: DomainPhaseInput,
  domain: EnabledDomain,
  chosen: Readonly<Record<string, string>>,
): Promise<string | null> {
  const stored = await bindingsOfProject(input.prisma, input.projectId);
  const bindings: CapabilityBinding[] = [];
  for (const env of targetsOf(domain, input.environments)) {
    const resolved = resolvedFor(stored, chosen, env?.id ?? null);
    const result = await domain.adapter.deploy(
      contextFor(input, domain, env, resolved),
      domain.config,
    );
    if (result.status !== "SUCCESS") {
      return result.message ?? `deploy trả ${result.status}`;
    }
    for (const b of result.data ?? []) {
      // Adapter theo namespace khai binding cho environment nó vừa deploy
      bindings.push(
        env === undefined || b.environmentId !== undefined
          ? b
          : { ...b, environmentId: env.id },
      );
    }
  }
  await input.prisma.$transaction(async (tx) => {
    for (const b of bindings) {
      await upsertBinding(tx, bindingRowOf(domain.id, b));
    }
    await tx.domainConfig.update({
      where: { id: domain.id },
      data: {
        domainStatus: "ACTIVE",
        adapterVersion: domain.adapter.version,
        lastError: Prisma.DbNull,
      },
    });
  });
  return null;
}

export async function runDomainPhase(
  input: DomainPhaseInput,
): Promise<DomainPhaseOutcome> {
  const domains = await enabledDomains(input);
  if (!Array.isArray(domains)) return { status: "FAILED", ...domains };
  if (domains.length === 0) return { status: "DONE", deployed: [] };
  const ordered = await tiersOf(input, domains);
  if (!("tiers" in ordered)) return { status: "FAILED", ...ordered };

  const deployed: string[] = [];
  for (const [index, tier] of ordered.tiers.entries()) {
    await input.fence.assert();
    const pending = tier.filter((d) => !d.alreadyActive);
    await input.prisma.domainConfig.updateMany({
      where: { id: { in: pending.map((d) => d.id) } },
      data: { domainStatus: "DEPLOYING" },
    });
    const failures = (
      await Promise.all(
        pending.map(async (d) => {
          const message = await deployOne(input, d, ordered.chosen).catch(
            messageOf,
          );
          return message === null ? null : { d, message };
        }),
      )
    ).filter((f) => f !== null);
    const first = failures[0];
    if (first === undefined) {
      deployed.push(...tier.map((d) => d.domainType));
      continue;
    }

    for (const f of failures) {
      await input.prisma.domainConfig.update({
        where: { id: f.d.id },
        data: {
          domainStatus: "ERROR",
          lastError: lastErrorOf("DEPLOY", f.message),
        },
      });
    }
    await input.prisma.domainConfig.updateMany({
      where: {
        id: {
          in: ordered.tiers.slice(index + 1).flatMap((t) => t.map((d) => d.id)),
        },
      },
      data: { domainStatus: "BLOCKED" },
    });
    return {
      status: "FAILED",
      domainType: first.d.domainType,
      message: first.message,
    };
  }
  return { status: "DONE", deployed };
}

/** Domain đã chạm cluster (kể cả dở dang) — thứ bù trừ phải gỡ */
const TOUCHED: readonly DomainStatus[] = ["DEPLOYING", "ACTIVE", "ERROR"];

async function teardownOne(
  input: DomainPhaseInput,
  domain: EnabledDomain,
): Promise<string | null> {
  for (const env of targetsOf(domain, input.environments)) {
    const r = await domain.adapter.teardown(
      contextFor(input, domain, env, {}),
      "project-teardown",
    );
    if (r.status !== "SUCCESS" && r.status !== "NOT_FOUND") {
      return r.message ?? `teardown trả ${r.status}`;
    }
  }
  return null;
}

/**
 * Gỡ domain khi BÙ TRỪ, ngược bậc deploy, TRƯỚC khi xoá hạ tầng cloud.
 *
 * Xoá cluster không xoá load balancer và volume mà Kubernetes đã sinh cho Service/PVC của
 * domain; chúng giữ tham chiếu tới VPC và làm bước xoá mạng thất bại vĩnh viễn trong khi
 * vẫn tính tiền (§4.2 thứ tự teardown). Gỡ thất bại không chặn bù trừ cloud: trả về danh
 * sách lỗi để job ghi lại, và bước xoá mạng tự đánh `ORPHAN_SUSPECTED` nếu còn bị giữ.
 */
export async function teardownDomains(
  input: DomainPhaseInput,
): Promise<string[]> {
  const domains = await enabledDomains(input, TOUCHED);
  if (!Array.isArray(domains)) return [domains.message];
  if (domains.length === 0) return [];
  const ordered = await tiersOf(input, domains);
  const tiers = "tiers" in ordered ? ordered.tiers : [domains];
  const failures: string[] = [];
  for (const tier of [...tiers].reverse()) {
    await input.fence.assert();
    await Promise.all(
      tier.map(async (d) => {
        const message = await teardownOne(input, d).catch(messageOf);
        if (message !== null) failures.push(`${d.domainType}: ${message}`);
        await input.prisma.$transaction(async (tx) => {
          if (message === null) await deleteBindingsOfDomainConfig(tx, d.id);
          await tx.domainConfig.update({
            where: { id: d.id },
            data:
              message === null
                ? { domainStatus: "PENDING", lastError: Prisma.DbNull }
                : {
                    domainStatus: "ERROR",
                    lastError: lastErrorOf("TEARDOWN", message),
                  },
          });
        });
      }),
    );
  }
  return failures;
}
