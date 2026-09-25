import type {
  CapabilityBinding,
  CapabilityDeclaration,
} from "@udp/shared-types";
import type {
  DomainAdapter,
  DomainToolConfig,
  ReadOnlyAdapterContext,
} from "@udp/adapter-core";
import type { ZodType } from "zod";

/**
 * `RegistryAdapter` — lớp nền thứ ba (Plan #35 QĐ-3b), cho registry DỊCH VỤ: ECR, Artifact
 * Registry, ACR, Docker Hub, GHCR, GitHub Packages.
 *
 * Không cài gì vào cluster và không gọi API nào: registry đã chạy ở nhà cung cấp, và việc cluster
 * KÉO được image là của định danh node (registry của cloud) hay của `udp-registry-pull` mà nền
 * tảng phân phối từ `pullCredential` (QĐ-2, QĐ-3). Thứ adapter để lại trong cluster đúng một
 * ConfigMap mô tả registry trong `udp-system` — nguồn đọc cho workload và là đích của drift —
 * cùng binding `registry.oci` (và `packages.store` nếu có).
 */

export interface RegistryAdapterSpec {
  domainType: DomainAdapter["domainType"];
  toolId: string;
  version: string;
  capabilities: CapabilityDeclaration;
  configSchema: ZodType;
  /** Mô tả registry — KHÔNG mang khoá; khoá đi đường `pullCredential` */
  describe: (config: DomainToolConfig) => Record<string, string>;
  bindings: (
    ctx: ReadOnlyAdapterContext,
    config: DomainToolConfig,
  ) => CapabilityBinding[];
  /** Prefix khoá bỏ qua khi so drift — cùng luật tường minh với hai lớp nền kia */
  ignoredKeyPrefixes?: readonly string[];
}

export class RegistryAdapterError extends Error {
  readonly code = "REGISTRY_ADAPTER_FAILED";
  constructor(message: string) {
    super(message);
    this.name = "RegistryAdapterError";
  }
}

/** So ĐẦY ĐỦ hai chiều — khoá lạ cũng là drift trừ prefix đã khai (cùng luật hai lớp nền kia) */
function driftBetween(
  desired: Record<string, unknown>,
  actual: Record<string, unknown>,
  ignoredPrefixes: readonly string[],
): { drifted: boolean; details?: string } {
  const differing = Object.keys(desired).filter(
    (k) => JSON.stringify(actual[k]) !== JSON.stringify(desired[k]),
  );
  const unexpected = Object.keys(actual).filter(
    (k) => !(k in desired) && !ignoredPrefixes.some((p) => k.startsWith(p)),
  );
  if (differing.length === 0 && unexpected.length === 0) {
    return { drifted: false };
  }
  const parts: string[] = [];
  if (differing.length > 0) parts.push(`khác ở: ${differing.join(", ")}`);
  if (unexpected.length > 0) parts.push(`có khoá lạ: ${unexpected.join(", ")}`);
  return { drifted: true, details: parts.join("; ") };
}

export function createRegistryAdapter(
  spec: RegistryAdapterSpec,
): DomainAdapter {
  if (spec.capabilities.requires.length > 0) {
    // Lớp nền không có gì để áp lại khi dependency đổi — một `requires` ở đây là lời khai rỗng
    throw new RegistryAdapterError(
      `${spec.toolId}: registry dịch vụ không requires capability nào`,
    );
  }
  const descriptionRef = (ctx: ReadOnlyAdapterContext) => ({
    apiVersion: "v1",
    kind: "ConfigMap",
    namespace: ctx.systemNamespace,
    name: `udp-registry-${spec.toolId}`,
  });

  const desiredOf = (config: DomainToolConfig): Record<string, unknown> => ({
    provider: spec.toolId,
    registry: spec.describe(config),
  });

  const parse = (config: DomainToolConfig): void => {
    if (!spec.configSchema.safeParse(config).success) {
      throw new RegistryAdapterError(
        `config không hợp lệ theo configSchema của ${spec.toolId}`,
      );
    }
  };

  async function guarded<T>(
    fn: () => Promise<T>,
  ): Promise<
    { status: "SUCCESS"; data: T } | { status: "FAILED"; message: string }
  > {
    try {
      return { status: "SUCCESS", data: await fn() };
    } catch (err) {
      if (err instanceof RegistryAdapterError) {
        return { status: "FAILED", message: err.message };
      }
      // Lỗi từ nơi khác chỉ để lại `name` — thông điệp có thể mang dữ liệu đầu vào (§12 T3)
      return {
        status: "FAILED",
        message: err instanceof Error ? err.name : "lỗi không rõ",
      };
    }
  }

  async function describeRegistry(
    ctx: Parameters<DomainAdapter["deploy"]>[0],
    config: DomainToolConfig,
  ): Promise<CapabilityBinding[]> {
    parse(config);
    ctx.progress(`khai registry ${spec.toolId}`);
    const client = await ctx.k8s.getClient("tooling");
    await client.write("apply", descriptionRef(ctx), desiredOf(config));
    return spec.bindings(ctx, config);
  }

  return {
    domainType: spec.domainType,
    toolId: spec.toolId,
    version: spec.version,
    scope: "cluster",
    capabilities: spec.capabilities,
    configSchema: spec.configSchema,

    deploy: (ctx, config) => guarded(() => describeRegistry(ctx, config)),
    configure: (ctx, config) => guarded(() => describeRegistry(ctx, config)),

    upgrade: (ctx, config, fromVersion) =>
      guarded(async () => {
        if (fromVersion !== spec.version) {
          throw new RegistryAdapterError(
            `không biết đường nâng cấp ${spec.toolId} từ ${fromVersion}`,
          );
        }
        return await describeRegistry(ctx, config);
      }),

    detectDrift: (ctx, config) =>
      guarded(async () => {
        parse(config);
        // CHỈ ĐỌC (I32 chiều c)
        const client = await ctx.k8s.getClient("tooling");
        const found = await client.read<Record<string, unknown>>(
          "get",
          descriptionRef(ctx),
        );
        if (found === null) {
          return { drifted: true, details: "thiếu ConfigMap mô tả registry" };
        }
        return driftBetween(
          desiredOf(config),
          found,
          spec.ignoredKeyPrefixes ?? [],
        );
      }),

    /** Registry dịch vụ không `requires` gì — dependency đổi là no-op thành công, không ghi */
    onDependencyChanged: () => guarded(() => Promise.resolve(undefined)),

    healthcheck: (ctx) =>
      guarded(async () => {
        const client = await ctx.k8s.getClient("tooling");
        const found = await client.read("get", descriptionRef(ctx));
        return found === null
          ? { healthy: false, details: "chưa khai registry" }
          : { healthy: true };
      }),

    /** Chỉ gỡ phần UDP dựng — registry và image của khách ở nhà cung cấp KHÔNG bị chạm */
    teardown: (ctx) =>
      guarded(async () => {
        const client = await ctx.k8s.getClient("tooling");
        await client.write("delete", descriptionRef(ctx));
        return undefined;
      }),
  };
}
