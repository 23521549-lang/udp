import type {
  CapabilityDeclaration,
  CapabilityBinding,
} from "@udp/shared-types";
import type {
  DomainAdapter,
  DomainAdapterContext,
  DomainToolConfig,
} from "@udp/adapter-core";
import type { ZodType } from "zod";

/**
 * [v4.10] `HelmBasedAdapter` — lớp nền cho họ adapter cài bằng Helm (§5.2).
 *
 * Phần lớn domain của §5.1 được cài bằng một Helm chart cộng một ít CR: Prometheus,
 * Loki, Argo CD, Istio... Chúng khác nhau ở **chart nào, giá trị gì, binding nào**, và
 * giống nhau ở toàn bộ vòng đời: apply release, đọc lại để healthcheck, so giá trị mong
 * muốn với giá trị thật để tìm drift, xoá release khi tắt.
 *
 * Nên lớp nền này giữ **vòng đời**, còn adapter cụ thể khai **dữ liệu**. Đó là điều kiện
 * để luận điểm pluggable có nghĩa: nếu mỗi adapter tự viết lại vòng đời thì "mọi adapter
 * qua cùng một bộ hợp đồng" chỉ đúng vì 37 phép kiểm được lặp lại 16 lần bằng tay.
 *
 * **Ba ràng buộc mà lớp nền cưỡng chế cho MỌI adapter kế thừa nó:**
 *
 *  1. **Chỉ identity `tooling`** (§12.2). Adapter không chọn identity; lớp nền chọn.
 *  2. **Chỉ namespace của environment hoặc `systemNamespace`.** Adapter khai `scope`, lớp
 *     nền suy namespace từ đó — không có đường nào để adapter ghi vào namespace khác.
 *  3. **Không `fetch` toàn cục.** Lớp nền không gọi ra ngoài; adapter nào cần thì đi qua
 *     `ctx.fetch` và khai host trong `AdapterFixture`.
 */

export interface HelmChartRef {
  name: string;
  /** Version của chart, semver đầy đủ — `detectDrift` so với giá trị thật */
  version: string;
  repo: string;
}

export interface HelmAdapterSpec {
  domainType: DomainAdapter["domainType"];
  toolId: string;
  /** Version của ADAPTER, ghi vào `DomainConfig.adapter_version` */
  version: string;
  scope: DomainAdapter["scope"];
  capabilities: CapabilityDeclaration;
  configSchema: ZodType;
  chart: HelmChartRef;
  /** Tên release, ổn định qua các lượt deploy — điều kiện của tính idempotent */
  releaseName: string;
  /**
   * Giá trị Helm suy từ config và từ binding đã resolve.
   *
   * NÉM nếu thiếu một binding mà adapter `requires`: tự đoán endpoint là lỗi vỡ ngay khi
   * người dùng đổi provider, và nó vỡ ở lúc chạy chứ không ở lúc cấu hình.
   */
  values: (
    config: DomainToolConfig,
    ctx: DomainAdapterContext,
  ) => Record<string, unknown>;
  /** Binding mà adapter cung cấp sau khi deploy xong */
  bindings: (ctx: DomainAdapterContext) => CapabilityBinding[];
  /**
   * Chiều quota adapter tiêu thụ; lớp nền TỪ CHỐI khi chiều đó bằng 0.
   *
   * Khai ở đây chứ không chỉ ở `AdapterFixture` vì fixture là của TEST, còn đây là hành
   * vi của sản phẩm. Hai chỗ khai cùng một sự thật, và bộ hợp đồng là chốt giữ chúng khớp:
   * fixture nói "tôi tiêu thụ chiều này", và phép d8 đòi adapter thật sự từ chối.
   */
  quotaDimensions: readonly (keyof DomainAdapterContext["quota"])[];
}

const RELEASE_KIND = "HelmRelease";
const VALUES_KIND = "ConfigMap";

export class HelmAdapterError extends Error {
  readonly code = "HELM_ADAPTER_FAILED";
  constructor(message: string) {
    super(message);
    this.name = "HelmAdapterError";
  }
}

export function createHelmBasedAdapter(spec: HelmAdapterSpec): DomainAdapter {
  /**
   * Namespace đích, suy từ `scope` — adapter KHÔNG được tự chọn.
   *
   * §5.2: adapter cluster-scoped cài MỘT lần vào `udp-system`; chỉ CR mới theo namespace
   * của environment. Bản v3 bắt mọi adapter deploy vào namespace env, và điều đó không
   * thực hiện được cho nửa số domain.
   */
  const nsOf = (ctx: DomainAdapterContext): string =>
    spec.scope === "cluster"
      ? ctx.systemNamespace
      : (ctx.environment?.k8sNamespace ?? ctx.systemNamespace);

  const releaseRef = (ctx: DomainAdapterContext) => ({
    apiVersion: "helm.toolkit.fluxcd.io/v2",
    kind: RELEASE_KIND,
    namespace: nsOf(ctx),
    name: spec.releaseName,
  });

  const valuesRef = (ctx: DomainAdapterContext) => ({
    apiVersion: "v1",
    kind: VALUES_KIND,
    namespace: nsOf(ctx),
    name: `${spec.releaseName}-values`,
  });

  /** Nội dung mong muốn — `detectDrift` so với chính cấu trúc này */
  function desiredOf(
    config: DomainToolConfig,
    ctx: DomainAdapterContext,
  ): Record<string, unknown> {
    return {
      chart: spec.chart.name,
      chartVersion: spec.chart.version,
      repo: spec.chart.repo,
      values: spec.values(config, ctx),
    };
  }

  function assertQuota(ctx: DomainAdapterContext): void {
    for (const dim of spec.quotaDimensions) {
      const value = ctx.quota[dim];
      if (typeof value === "number" && value <= 0) {
        throw new HelmAdapterError(
          `vượt quota: ${String(dim)} phải lớn hơn 0 cho ${spec.toolId}`,
        );
      }
    }
  }

  async function applyRelease(
    ctx: DomainAdapterContext,
    config: DomainToolConfig,
  ): Promise<CapabilityBinding[]> {
    const parsed = spec.configSchema.safeParse(config);
    if (!parsed.success) {
      throw new HelmAdapterError(
        `config không hợp lệ theo configSchema của ${spec.toolId}`,
      );
    }
    assertQuota(ctx);

    ctx.progress(`áp ${spec.chart.name} ${spec.chart.version}`);
    /** Identity CỐ ĐỊNH là `tooling` — adapter không có đường chọn khác (§12.2) */
    const client = await ctx.k8s.getClient("tooling");
    const desired = desiredOf(config, ctx);

    await client.write("apply", valuesRef(ctx), desired);
    await client.write("apply", releaseRef(ctx), {
      chart: spec.chart.name,
      version: spec.chart.version,
      repo: spec.chart.repo,
      valuesFrom: `${spec.releaseName}-values`,
    });
    ctx.progress(`${spec.toolId} đã sẵn sàng`);
    return spec.bindings(ctx);
  }

  /**
   * Bọc mọi lời gọi: NÉM thành `AdapterResult` FAILED, và thông điệp KHÔNG mang dữ liệu
   * đầu vào.
   *
   * `err.message` của `HelmAdapterError` do chính lớp nền viết, nên nó an toàn. Một lỗi
   * đến từ nơi khác (SDK, mạng) chỉ để lại `name`: §12 T3 nói một số SDK nhét credential
   * vào `error.config`, và `AdapterResult.message` là thứ Portal hiển thị.
   */
  async function guarded<T>(
    fn: () => Promise<T>,
  ): Promise<{ status: "SUCCESS"; data: T } | { status: "FAILED"; message: string }> {
    try {
      return { status: "SUCCESS", data: await fn() };
    } catch (err) {
      if (err instanceof HelmAdapterError) {
        return { status: "FAILED", message: err.message };
      }
      return {
        status: "FAILED",
        message: err instanceof Error ? err.name : "lỗi không rõ",
      };
    }
  }

  const adapter: DomainAdapter = {
    domainType: spec.domainType,
    toolId: spec.toolId,
    version: spec.version,
    scope: spec.scope,
    capabilities: spec.capabilities,
    configSchema: spec.configSchema,

    deploy: (ctx, config) => guarded(() => applyRelease(ctx, config)),

    /** Với họ Helm, `configure` là cùng một đường: giá trị mới ⇒ release mới */
    configure: (ctx, config) => guarded(() => applyRelease(ctx, config)),

    upgrade: (ctx, config, fromVersion) =>
      guarded(async () => {
        /**
         * `fromVersion` lạ ⇒ TỪ CHỐI.
         *
         * Nâng cấp là một đường di trú: không biết đang ở đâu thì không biết phải chạy
         * bước nào. Và §8.6 nói `detectDrift()` so với `adapter_version`, nên một lần
         * upgrade "thành công" từ một version không biết sẽ làm mọi lần quét sau báo trôi
         * giả.
         */
        if (fromVersion !== spec.version) {
          throw new HelmAdapterError(
            `không biết đường nâng cấp ${spec.toolId} từ ${fromVersion}`,
          );
        }
        return await applyRelease(ctx, config);
      }),

    detectDrift: (ctx, config) =>
      guarded(async () => {
        const parsed = spec.configSchema.safeParse(config);
        if (!parsed.success) {
          throw new HelmAdapterError("config không hợp lệ theo configSchema");
        }
        /**
         * CHỈ ĐỌC. I32 chiều (c): hệ thống không bao giờ tự sửa drift.
         *
         * Bảo đảm tầng một là kiểu (`detectDrift` nhận client chỉ đọc ở §4.6); ở đây lớp
         * nền giữ kỷ luật đó cho mọi adapter kế thừa, nên một adapter cụ thể không có
         * đường nào ghi trong lúc quét.
         */
        const client = await ctx.k8s.getClient("tooling");
        const found = await client.read<Record<string, unknown>>(
          "get",
          valuesRef(ctx),
        );
        if (found === null) {
          return { drifted: true, details: "thiếu ConfigMap giá trị của release" };
        }
        const desired = desiredOf(config, ctx);
        const differing = Object.keys(desired).filter(
          (k) => JSON.stringify(found[k]) !== JSON.stringify(desired[k]),
        );
        return differing.length === 0
          ? { drifted: false }
          : { drifted: true, details: `khác ở: ${differing.join(", ")}` };
      }),

    onDependencyChanged: (ctx, config, changed) =>
      guarded(async () => {
        const needed = spec.capabilities.requires.flatMap((r) =>
          "anyOf" in r ? r.anyOf.map((x) => x.id) : [r.id],
        );
        /** Capability không liên quan ⇒ no-op THÀNH CÔNG, và không ghi gì */
        if (!needed.includes(changed.id)) return undefined;
        /**
         * Áp lại release với `resolved` MỚI.
         *
         * `spec.values` đọc `ctx.resolved`, nên áp lại là cách duy nhất để endpoint mới đi
         * vào giá trị Helm. Sửa tay một trường trong ConfigMap sẽ để release và ConfigMap
         * lệch nhau, và lần `detectDrift` sau báo trôi.
         */
        const client = await ctx.k8s.getClient("tooling");
        await client.write("patch", valuesRef(ctx), {
          values: spec.values(config, {
            ...ctx,
            resolved: { ...ctx.resolved, [changed.id]: changed },
          }),
        });
        return undefined;
      }),

    healthcheck: (ctx) =>
      guarded(async () => {
        const client = await ctx.k8s.getClient("tooling");
        const found = await client.read("get", releaseRef(ctx));
        /** Chưa cài ⇒ `healthy: false`, KHÔNG ném: Portal gọi hàm này ở mọi trạng thái */
        return found === null
          ? { healthy: false, details: "chưa có Helm release" }
          : { healthy: true };
      }),

    teardown: (ctx, reason) =>
      guarded(async () => {
        const client = await ctx.k8s.getClient("tooling");
        await client.write("delete", releaseRef(ctx));
        /**
         * `reason = "switch"` GIỮ ConfigMap giá trị.
         *
         * Đổi tool thì cấu hình cũ còn ích: người vận hành so được cái mới với cái cũ, và
         * một lần đổi ngược lại không mất thiết lập. Tắt domain hay xoá project thì dọn
         * sạch — §5.2 nói `reason` tồn tại đúng để phân biệt hai việc đó.
         */
        if (reason !== "switch") {
          await client.write("delete", valuesRef(ctx));
        }
        return undefined;
      }),
  };

  return adapter;
}
