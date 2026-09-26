import type {
  CapabilityBinding,
  CapabilityDeclaration,
} from "@udp/shared-types";
import type {
  DomainAdapter,
  DomainAdapterContext,
  DomainToolConfig,
  ReadOnlyAdapterContext,
} from "@udp/adapter-core";
import type { ZodType } from "zod";

/**
 * `DescriptorAdapter` — lớp nền thứ ba, cho tool KHÔNG cài gì vào cluster và không cần gọi API nào
 * để dùng được (Plan #35 dựng nó cho registry; Plan #36 gộp thành lớp chung và mở `requires`):
 * registry dịch vụ (ECR, GHCR…, qua `registry.ts`) và CI dịch vụ (GitHub Actions, GitLab CI,
 * CircleCI).
 *
 * Thứ nó để lại trong cluster đúng MỘT ConfigMap mô tả trong `udp-system` — nguồn đọc cho
 * workload và đích của drift. Mô tả có thể đọc binding đã resolve (CI ghi `registryRef` mà nó
 * đẩy image tới): `describe` NÉM khi thiếu binding mà adapter `requires` (luật "không đoán" của
 * §5.2), và `onDependencyChanged` ghi lại mô tả với binding MỚI.
 */

export interface DescriptorAdapterSpec {
  domainType: DomainAdapter["domainType"];
  toolId: string;
  version: string;
  capabilities: CapabilityDeclaration;
  configSchema: ZodType;
  /** Tên ConfigMap mô tả trong `udp-system` — ổn định qua các lượt, đích của drift */
  descriptorName: string;
  /** Mô tả — KHÔNG mang khoá; khoá đi đường bí mật của tool hay `pullCredential` */
  describe: (
    config: DomainToolConfig,
    ctx: ReadOnlyAdapterContext,
  ) => Record<string, string>;
  bindings: (
    ctx: ReadOnlyAdapterContext,
    config: DomainToolConfig,
  ) => CapabilityBinding[];
  /** Prefix khoá bỏ qua khi so drift — lời khai tường minh, như hai lớp nền kia */
  ignoredKeyPrefixes?: readonly string[];
}

export class DescriptorAdapterError extends Error {
  readonly code = "DESCRIPTOR_ADAPTER_FAILED";
  constructor(message: string) {
    super(message);
    this.name = "DescriptorAdapterError";
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

export function createDescriptorAdapter(
  spec: DescriptorAdapterSpec,
): DomainAdapter {
  const descriptionRef = (ctx: ReadOnlyAdapterContext) => ({
    apiVersion: "v1",
    kind: "ConfigMap",
    namespace: ctx.systemNamespace,
    name: spec.descriptorName,
  });

  const desiredOf = (
    config: DomainToolConfig,
    ctx: ReadOnlyAdapterContext,
  ): Record<string, unknown> => ({
    provider: spec.toolId,
    description: spec.describe(config, ctx),
  });

  const needed = spec.capabilities.requires.flatMap((r) =>
    "anyOf" in r ? r.anyOf.map((x) => x.id) : [r.id],
  );

  const parse = (config: DomainToolConfig): void => {
    if (!spec.configSchema.safeParse(config).success) {
      throw new DescriptorAdapterError(
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
      if (err instanceof DescriptorAdapterError) {
        return { status: "FAILED", message: err.message };
      }
      // Lỗi từ nơi khác chỉ để lại `name` — thông điệp có thể mang dữ liệu đầu vào (§12 T3)
      return {
        status: "FAILED",
        message: err instanceof Error ? err.name : "lỗi không rõ",
      };
    }
  }

  async function describeTool(
    ctx: DomainAdapterContext,
    config: DomainToolConfig,
  ): Promise<CapabilityBinding[]> {
    parse(config);
    ctx.progress(`khai ${spec.toolId}`);
    const client = await ctx.k8s.getClient("tooling");
    await client.write("apply", descriptionRef(ctx), desiredOf(config, ctx));
    return spec.bindings(ctx, config);
  }

  return {
    domainType: spec.domainType,
    toolId: spec.toolId,
    version: spec.version,
    scope: "cluster",
    capabilities: spec.capabilities,
    configSchema: spec.configSchema,

    deploy: (ctx, config) => guarded(() => describeTool(ctx, config)),
    configure: (ctx, config) => guarded(() => describeTool(ctx, config)),

    upgrade: (ctx, config, fromVersion) =>
      guarded(async () => {
        if (fromVersion !== spec.version) {
          throw new DescriptorAdapterError(
            `không biết đường nâng cấp ${spec.toolId} từ ${fromVersion}`,
          );
        }
        return await describeTool(ctx, config);
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
          return { drifted: true, details: "thiếu ConfigMap mô tả" };
        }
        return driftBetween(
          desiredOf(config, ctx),
          found,
          spec.ignoredKeyPrefixes ?? [],
        );
      }),

    /** Mô tả đọc binding ⇒ binding mới phải vào mô tả; capability không liên quan là no-op */
    onDependencyChanged: (ctx, config, changed) =>
      guarded(async () => {
        if (!needed.includes(changed.id)) return undefined;
        const client = await ctx.k8s.getClient("tooling");
        await client.write(
          "apply",
          descriptionRef(ctx),
          desiredOf(config, {
            ...ctx,
            resolved: { ...ctx.resolved, [changed.id]: changed },
          }),
        );
        return undefined;
      }),

    healthcheck: (ctx) =>
      guarded(async () => {
        const client = await ctx.k8s.getClient("tooling");
        const found = await client.read("get", descriptionRef(ctx));
        return found === null
          ? { healthy: false, details: `chưa khai ${spec.toolId}` }
          : { healthy: true };
      }),

    /** Chỉ gỡ phần UDP dựng — tài khoản, repo, image của khách ở nhà cung cấp KHÔNG bị chạm */
    teardown: (ctx) =>
      guarded(async () => {
        const client = await ctx.k8s.getClient("tooling");
        await client.write("delete", descriptionRef(ctx));
        return undefined;
      }),
  };
}
