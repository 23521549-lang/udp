import {
  readOnlyContext,
  type ClusterAccess,
  type DomainAdapter,
  type DomainAdapterContext,
  type ResourceQuota,
} from "@udp/adapter-core";
import type { Fence } from "@udp/adapter-core/runner";
import { Prisma, type DomainStatus, type PrismaClient } from "@udp/db";
import type {
  AdapterResult,
  CapabilityBinding,
  CapabilityId,
} from "@udp/shared-types";
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
import { openSecrets } from "../domain/tool-secrets.js";
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

/** Một domain cụ thể: hàng `domain_configs` + adapter + cấu hình đã parse */
export interface DeployTarget {
  id: string;
  domainType: string;
  adapter: DomainAdapter;
  /** Bản RÕ cho adapter — chỉ sống trong bộ nhớ worker */
  config: Record<string, unknown>;
  /** Bản ghi xuống bảng — bí mật NIÊM PHONG (Plan #31); không bao giờ là `config` */
  storedConfig: Record<string, unknown>;
}

interface EnabledDomain extends DeployTarget {
  alreadyActive: boolean;
}

interface Problem {
  domainType: string;
  message: string;
}

export type DomainErrorStep = "DEPLOY" | "TEARDOWN" | "HEALTHCHECK" | "NOTIFY";

/** `last_error` của domain — cùng hình `{ step, message, adapterResult }` mà Portal đọc */
export const lastErrorOf = (step: DomainErrorStep, message: string) => ({
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
    const stored =
      typeof r.toolConfig === "object" &&
      r.toolConfig !== null &&
      !Array.isArray(r.toolConfig)
        ? (r.toolConfig as Record<string, unknown>)
        : {};
    const parsed = adapter.configSchema.safeParse(
      openSecrets(
        { projectId: input.projectId, domainType: r.domainType },
        stored,
      ),
    );
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
      storedConfig: stored,
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
export const targetsOf = (
  adapter: DomainAdapter,
  environments: readonly PhaseEnvironment[],
): (PhaseEnvironment | undefined)[] =>
  adapter.scope === "cluster" ? [undefined] : [...environments];

/** Bối cảnh cho MỘT lời gọi adapter trên MỘT đích (cluster, hay một environment) */
export function adapterContext(
  input: DomainPhaseInput,
  adapter: DomainAdapter,
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
      input.progress(`${adapter.domainType}: ${m}`);
    },
    fetch: input.fetch,
  };
}

type BindingCall = (
  ctx: DomainAdapterContext,
  config: Record<string, unknown>,
) => Promise<AdapterResult<CapabilityBinding[]>>;

/**
 * Gọi `deploy`/`configure` của một adapter trên MỌI đích của nó; binding theo namespace mang
 * environment vừa gọi. `resolved` nạp lại TỪ BẢNG mỗi lần — không từ bộ nhớ worker.
 */
export async function callOnTargets(
  input: DomainPhaseInput,
  target: DeployTarget,
  chosen: Readonly<Record<string, string>>,
  call: BindingCall,
): Promise<{ bindings: CapabilityBinding[] } | { error: string }> {
  const stored = await bindingsOfProject(input.prisma, input.projectId);
  const bindings: CapabilityBinding[] = [];
  for (const env of targetsOf(target.adapter, input.environments)) {
    const resolved = resolvedFor(stored, chosen, env?.id ?? null);
    const result = await call(
      adapterContext(input, target.adapter, env, resolved),
      target.config,
    );
    if (result.status !== "SUCCESS") {
      return { error: result.message ?? `adapter trả ${result.status}` };
    }
    for (const b of result.data ?? []) {
      bindings.push(
        env === undefined || b.environmentId !== undefined
          ? b
          : { ...b, environmentId: env.id },
      );
    }
  }
  return { bindings };
}

/**
 * Ghi một domain đã chạy xong lên cluster: binding + tool + cấu hình + `adapter_version` +
 * `ACTIVE` trong MỘT transaction. `replace` xoá binding cũ của hàng trước (đổi tool: tool
 * mới có thể không cung cấp lại mọi capability của tool cũ).
 */
export async function persistDeployed(
  prisma: PrismaClient,
  target: DeployTarget,
  bindings: readonly CapabilityBinding[],
  options: { replace: boolean },
): Promise<void> {
  await prisma.$transaction(async (tx) => {
    if (options.replace) await deleteBindingsOfDomainConfig(tx, target.id);
    for (const b of bindings) {
      await upsertBinding(tx, bindingRowOf(target.id, b));
    }
    await tx.domainConfig.update({
      where: { id: target.id },
      data: {
        isEnabled: true,
        selectedTool: target.adapter.toolId,
        toolConfig: target.storedConfig as Prisma.InputJsonValue,
        adapterVersion: target.adapter.version,
        domainStatus: "ACTIVE",
        lastError: Prisma.DbNull,
      },
    });
  });
}

/** Deploy một domain lên mọi đích của nó; `null` = thành công, chuỗi = lý do lỗi */
async function deployOne(
  input: DomainPhaseInput,
  domain: EnabledDomain,
  chosen: Readonly<Record<string, string>>,
): Promise<string | null> {
  const outcome = await callOnTargets(input, domain, chosen, (ctx, config) =>
    domain.adapter.deploy(ctx, config),
  );
  if ("error" in outcome) return outcome.error;
  await persistDeployed(input.prisma, domain, outcome.bindings, {
    replace: false,
  });
  return null;
}

/**
 * Bọc một adapter theo namespace để các hook mà luồng Day-2 gọi MỘT lần (`detectDrift`,
 * `onDependencyChanged`, `upgrade`, `healthcheck`) chạy trên MỌI environment rồi gộp kết
 * quả: trôi, lỗi hay không khoẻ ở một environment là của cả domain; binding của `upgrade`
 * mang environment của nó. Adapter phạm vi cluster đi thẳng.
 */
export function perEnvironment(
  adapter: DomainAdapter,
  environments: readonly PhaseEnvironment[],
): DomainAdapter {
  if (adapter.scope === "cluster") return adapter;
  return {
    ...adapter,
    detectDrift: async (ctx, config) => {
      const drifted: string[] = [];
      for (const environment of environments) {
        // Bối cảnh vào đã chỉ đọc; hạ lần nữa để bất biến I32-c đứng ở MỌI chỗ gọi
        const res = await adapter.detectDrift(
          readOnlyContext({ ...ctx, environment }),
          config,
        );
        if (res.status !== "SUCCESS" || res.data === undefined) return res;
        if (res.data.drifted) {
          drifted.push(
            `${environment.name}: ${res.data.details ?? "đã trôi cấu hình"}`,
          );
        }
      }
      return {
        status: "SUCCESS",
        data:
          drifted.length === 0
            ? { drifted: false }
            : { drifted: true, details: drifted.join("; ") },
      };
    },
    onDependencyChanged: async (ctx, config, changed) => {
      for (const environment of environments) {
        const res = await adapter.onDependencyChanged(
          { ...ctx, environment },
          config,
          changed,
        );
        if (res.status !== "SUCCESS") return res;
      }
      return { status: "SUCCESS" };
    },
    upgrade: async (ctx, config, fromVersion) => {
      const bindings: CapabilityBinding[] = [];
      for (const environment of environments) {
        const res = await adapter.upgrade(
          { ...ctx, environment },
          config,
          fromVersion,
        );
        if (res.status !== "SUCCESS" || res.data === undefined) return res;
        bindings.push(
          ...res.data.map((b) =>
            b.environmentId === undefined
              ? { ...b, environmentId: environment.id }
              : b,
          ),
        );
      }
      return { status: "SUCCESS", data: bindings };
    },
    healthcheck: async (ctx) => {
      for (const environment of environments) {
        const res = await adapter.healthcheck({ ...ctx, environment });
        if (res.status !== "SUCCESS" || res.data?.healthy !== true) {
          return res.status === "SUCCESS"
            ? {
                status: "SUCCESS",
                data: {
                  healthy: false,
                  details: `${environment.name}: ${res.data?.details ?? "không khoẻ"}`,
                },
              }
            : res;
        }
      }
      return { status: "SUCCESS", data: { healthy: true } };
    },
  };
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

/** Gỡ một domain khỏi mọi đích của nó; `null` = thành công, chuỗi = lý do lỗi */
export async function teardownTarget(
  input: DomainPhaseInput,
  adapter: DomainAdapter,
  reason: "disable" | "switch" | "project-teardown",
): Promise<string | null> {
  for (const env of targetsOf(adapter, input.environments)) {
    const r = await adapter.teardown(
      adapterContext(input, adapter, env, {}),
      reason,
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
        const message = await teardownTarget(
          input,
          d.adapter,
          "project-teardown",
        ).catch(messageOf);
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
