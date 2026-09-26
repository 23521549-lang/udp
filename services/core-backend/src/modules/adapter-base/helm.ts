import type {
  CapabilityDeclaration,
  CapabilityBinding,
} from "@udp/shared-types";
import { envLabelFor } from "@udp/config";
import type {
  AdapterEnvironment,
  DomainAdapter,
  DomainAdapterContext,
  DomainToolConfig,
  ReadOnlyAdapterContext,
  ReadOnlyKubernetesClient,
} from "@udp/adapter-core";
import type { ZodType } from "zod";
import { secretRef, toolSecret, type ToolSecret } from "./cluster-secret.js";

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
  /**
   * [v4.11, Plan #37 QĐ-6] Nguồn KHÔNG phải Helm chart: nhà phát hành chỉ có bundle manifest
   * (Config Connector). Bản ghi release nói thẳng bộ cài áp bundle bằng `kubectl apply` thay vì
   * giả làm một chart. Vắng = Helm chart.
   */
  installer?: "manifest-bundle";
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
    ctx: ReadOnlyAdapterContext,
  ) => Record<string, unknown>;
  /** Binding mà adapter cung cấp sau khi deploy xong — endpoint có thể theo vùng của config */
  bindings: (
    ctx: ReadOnlyAdapterContext,
    config: DomainToolConfig,
  ) => CapabilityBinding[];
  /**
   * Chiều quota adapter tiêu thụ; lớp nền TỪ CHỐI khi chiều đó bằng 0.
   *
   * Khai ở đây chứ không chỉ ở `AdapterFixture` vì fixture là của TEST, còn đây là hành
   * vi của sản phẩm. Hai chỗ khai cùng một sự thật, và bộ hợp đồng là chốt giữ chúng khớp:
   * fixture nói "tôi tiêu thụ chiều này", và phép d8 đòi adapter thật sự từ chối.
   */
  quotaDimensions: readonly (keyof DomainAdapterContext["quota"])[];
  /**
   * Prefix khoá được BỊ QUA khi so drift, mỗi cái kèm lý do.
   *
   * [v4.10] Trường này là cặp sinh đôi của `AdapterFixture.ignoredLabelPrefixes`, và
   * nó tồn tại vì một lý do cụ thể: adapter tối thiểu của P20 phơi ra rằng lớp nền
   * so **tậ­p con** (chỉ đối chiếu những khoá nó tự đặt, bỏ qua mọi khoá lạ), trong khi
   * luậ­t của bộ hợp đồng nói `ignoredLabelPrefixes` RỖNG ⇒ **mọi** khác biệt là drift.
   * Hai điều đó không thể cùng đúng.
   *
   * Chốt: so **đầy đủ** hai chiều, và khoá lạ cũng là drift **trừ khi** nó khớp một
   * prefix ở đây. Nhời vậ­y "bỏ qua" trở thành một lời khai TƯỜNG MINH có lý do, thay
   * vì một hành vi mặc định không ai biết.
   */
  ignoredKeyPrefixes?: readonly string[];
  /**
   * Giá trị Helm MANG BÍ MẬT (license key, API key của agent) — Plan #31 QĐ-5.
   *
   * Lớp nền ghi chúng vào `Secret` `<releaseName>-secrets` và release đọc qua
   * `secretValuesFrom`; ConfigMap giá trị chỉ mang BĂM của chúng. Adapter `namespace`
   * không được khai: §12.2 chỉ cho `tooling` chạm `secrets` trong `udp-system`.
   */
  secretValues?: (
    config: DomainToolConfig,
    ctx: ReadOnlyAdapterContext,
  ) => Record<string, unknown>;
  /**
   * Khoá PHẲNG trong cùng `Secret` (Plan #32) — thứ workload khác mount bằng `secretKeyRef`
   * (mật khẩu, HEC token, license key), không đọc được từ `values.yaml` lồng nhau. Binding
   * trỏ tới chúng bằng TÊN `Secret` + khoá, không bao giờ bằng giá trị.
   */
  secretKeys?: (config: DomainToolConfig) => Record<string, string>;
  /**
   * Release ĐI KÈM, theo thứ tự áp (Plan #32): máy chủ lưu trữ là release chính, giao diện
   * và bộ thu log đi sau; gỡ thì ngược lại. Không mang bí mật riêng — đọc `Secret` của release
   * chính trong cùng namespace (một bí mật, một chỗ niêm phong, một chỗ xoá).
   */
  companions?: readonly HelmCompanion[];
  /**
   * [v4.11, Plan #38 QĐ-2] Release dựng cho MỖI environment (instance database của operator): tên
   * `<releasePrefix>-<nhãn env>`, bản ghi ở namespace của adapter, cài vào namespace của
   * environment qua `targetNamespace` — `udp-tooling` không ghi gì ở namespace env (§12.2). Áp sau
   * mọi release tĩnh (operator có trước instance), gỡ trước chúng.
   */
  perEnvironment?: HelmInstanceSpec;
  /**
   * [v4.11, Plan #38 QĐ-4] Nhu cầu tài nguyên THẬT theo cấu hình và số environment — lớp nền từ
   * chối khi nhu cầu vượt quota, trước khi ghi gì. Vắng: chỉ luật "chiều khai phải > 0".
   */
  demand?: (
    config: DomainToolConfig,
    ctx: ReadOnlyAdapterContext,
  ) => Partial<Record<keyof DomainAdapterContext["quota"], number>>;
}

export interface HelmInstanceSpec {
  releasePrefix: string;
  chart: HelmChartRef;
  /** Instance nhận `secretValues` (mật khẩu theo environment) — cùng luật với release đi kèm */
  readsSecretValues?: boolean;
  /** Cùng luật với `values` của release chính: NÉM khi thiếu binding */
  values: (
    config: DomainToolConfig,
    ctx: ReadOnlyAdapterContext,
    environment: AdapterEnvironment,
  ) => Record<string, unknown>;
}

export interface HelmCompanion {
  /** Tên release riêng, ổn định qua các lượt deploy */
  releaseName: string;
  chart: HelmChartRef;
  /** Cùng luật với `values` của release chính: NÉM khi thiếu binding */
  values: (
    config: DomainToolConfig,
    ctx: ReadOnlyAdapterContext,
  ) => Record<string, unknown>;
  /**
   * Release này cũng nhận `secretValues` (qua `secretValuesFrom` tới CÙNG `Secret` của release
   * chính) — cho chart chỉ nhận bí mật dưới dạng giá trị Helm (issuer key của Linkerd).
   */
  readsSecretValues?: boolean;
  /**
   * [v4.11, Plan #37 QĐ-7] Áp TRƯỚC release chính (và gỡ SAU nó) — thứ release chính cần có sẵn
   * lúc cài (cert-manager cho webhook của Azure Service Operator).
   */
  before?: boolean;
  /**
   * [v4.11, Plan #37] Thành phần NỀN mà nhiều domain cùng cần (cert-manager): cùng tên release,
   * cùng chart ở mọi adapter dùng nó (khai một lần ở `cert-manager.ts`), nên áp lần hai là không
   * đổi gì. Tắt một domain KHÔNG gỡ nó — domain khác còn cần; nó đi cùng cluster.
   */
  shared?: boolean;
}

/**
 * Có drift không — so ĐẦY ĐỦ HAI CHIỀU, không phải tậ­p con.
 *
 * Ba loại khác biệt, và loại thứ ba là loại bản đầu bỏ sót:
 *
 *  1. Khoá của ta có giá trị khác ⇒ drift.
 *  2. Khoá của ta biến mất ⇒ drift.
 *  3. Xuất hiện một khoá **lạ** ⇒ drift, trừ khi nó khớp một prefix được khai bỏ qua.
 *
 * Lần đầu chỉ có (1) và (2), nên một lần `patch` thêm trường không bị phát hiện — và
 * `ignoredKeyPrefixes` khi ấy không có việc gì, vì mọi thứ lạ đều đã được bỏ qua sẵn.
 */
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
  if (unexpected.length > 0) {
    parts.push(`có khoá lạ: ${unexpected.join(", ")}`);
  }
  return { drifted: true, details: parts.join("; ") };
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

/** Một release của adapter — release chính, release đi kèm, hay instance của một environment */
interface HelmUnit extends HelmCompanion {
  primary: boolean;
  /** Chỉ instance theo environment: namespace mà bộ cài đặt release vào */
  targetNamespace?: string;
}

/** Tên release instance của một environment — bộ hợp đồng và test đọc cùng luật */
export const instanceReleaseName = (
  prefix: string,
  environment: Pick<AdapterEnvironment, "name">,
): string => `${prefix}-${envLabelFor(environment.name)}`;

export function createHelmBasedAdapter(spec: HelmAdapterSpec): DomainAdapter {
  const hasSecret =
    spec.secretValues !== undefined || spec.secretKeys !== undefined;
  if (hasSecret && spec.scope !== "cluster") {
    // Lỗi của mã adapter, bắt lúc nạp registry chứ không lúc khách bật tool
    throw new HelmAdapterError(
      `${spec.toolId}: bí mật trên cluster chỉ dành cho adapter cluster-scoped (§12.2)`,
    );
  }

  /**
   * ĐÚNG thứ tự áp — release đi kèm `before`, release chính, rồi các release đi kèm còn lại; gỡ
   * theo thứ tự ngược
   */
  const companions = spec.companions ?? [];
  const units: readonly HelmUnit[] = [
    ...companions
      .filter((c) => c.before === true)
      .map((c) => ({ ...c, primary: false })),
    {
      releaseName: spec.releaseName,
      chart: spec.chart,
      values: spec.values,
      primary: true,
    },
    ...companions
      .filter((c) => c.before !== true)
      .map((c) => ({ ...c, primary: false })),
  ];
  if (new Set(units.map((u) => u.releaseName)).size !== units.length) {
    throw new HelmAdapterError(`${spec.toolId}: hai release trùng tên`);
  }

  /** Release tĩnh rồi instance của mọi environment hiện có — thứ tự áp; gỡ theo thứ tự ngược */
  const unitsFor = (ctx: ReadOnlyAdapterContext): readonly HelmUnit[] => {
    const instance = spec.perEnvironment;
    if (instance === undefined) return units;
    return [
      ...units,
      ...ctx.environments.map((environment): HelmUnit => ({
        releaseName: instanceReleaseName(instance.releasePrefix, environment),
        chart: instance.chart,
        values: (config, c) => instance.values(config, c, environment),
        primary: false,
        ...(instance.readsSecretValues === true
          ? { readsSecretValues: true }
          : {}),
        targetNamespace: environment.k8sNamespace,
      })),
    ];
  };

  /**
   * Namespace đích, suy từ `scope` — adapter KHÔNG được tự chọn.
   *
   * §5.2: adapter cluster-scoped cài MỘT lần vào `udp-system`; chỉ CR mới theo namespace
   * của environment. Bản v3 bắt mọi adapter deploy vào namespace env, và điều đó không
   * thực hiện được cho nửa số domain.
   */
  const nsOf = (ctx: ReadOnlyAdapterContext): string =>
    spec.scope === "cluster"
      ? ctx.systemNamespace
      : (ctx.environment?.k8sNamespace ?? ctx.systemNamespace);

  const releaseRef = (unit: HelmUnit, ctx: ReadOnlyAdapterContext) => ({
    apiVersion: "helm.toolkit.fluxcd.io/v2",
    kind: RELEASE_KIND,
    namespace: nsOf(ctx),
    name: unit.releaseName,
  });

  const valuesRef = (unit: HelmUnit, ctx: ReadOnlyAdapterContext) => ({
    apiVersion: "v1",
    kind: VALUES_KIND,
    namespace: nsOf(ctx),
    name: `${unit.releaseName}-values`,
  });

  const secretName = `${spec.releaseName}-secrets`;
  const secretOf = (
    config: DomainToolConfig,
    ctx: ReadOnlyAdapterContext,
  ): ToolSecret | null =>
    hasSecret
      ? toolSecret(nsOf(ctx), secretName, {
          ...(spec.secretValues === undefined
            ? {}
            : {
                "values.yaml": JSON.stringify(spec.secretValues(config, ctx)),
              }),
          ...spec.secretKeys?.(config),
        })
      : null;

  /** HelmRelease mong muốn — `applyRelease` ghi và `detectDrift` so cùng một cấu trúc */
  const releaseSpec = (unit: HelmUnit): Record<string, unknown> => ({
    chart: unit.chart.name,
    version: unit.chart.version,
    repo: unit.chart.repo,
    ...(unit.chart.installer === undefined
      ? {}
      : { installer: unit.chart.installer }),
    ...(unit.targetNamespace === undefined
      ? {}
      : { targetNamespace: unit.targetNamespace }),
    valuesFrom: `${unit.releaseName}-values`,
    ...((unit.primary || unit.readsSecretValues === true) &&
    spec.secretValues !== undefined
      ? { secretValuesFrom: secretName }
      : {}),
  });

  /**
   * Nội dung mong muốn của ConfigMap giá trị — `detectDrift` so với chính cấu trúc này. Băm
   * của bí mật vào MỌI release: release đi kèm cũng đọc `Secret`, và đổi khoá phải làm cả
   * nhóm thấy giá trị mới.
   */
  function desiredOf(
    unit: HelmUnit,
    config: DomainToolConfig,
    ctx: ReadOnlyAdapterContext,
  ): Record<string, unknown> {
    const secret = secretOf(config, ctx);
    return {
      chart: unit.chart.name,
      chartVersion: unit.chart.version,
      repo: unit.chart.repo,
      values: unit.values(config, ctx),
      ...(secret === null ? {} : { secretsDigest: secret.digest }),
    };
  }

  function assertQuota(
    ctx: DomainAdapterContext,
    config: DomainToolConfig,
  ): void {
    for (const dim of spec.quotaDimensions) {
      const value = ctx.quota[dim];
      if (typeof value === "number" && value <= 0) {
        throw new HelmAdapterError(
          `vượt quota: ${String(dim)} phải lớn hơn 0 cho ${spec.toolId}`,
        );
      }
    }
    const demand = spec.demand?.(config, ctx) ?? {};
    for (const [dim, needed] of Object.entries(demand)) {
      const limit = ctx.quota[dim as keyof typeof ctx.quota];
      if (typeof limit === "number" && needed > limit) {
        throw new HelmAdapterError(
          `vượt quota: ${spec.toolId} cần ${dim} = ${String(needed)}, trần là ${String(limit)}`,
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
    assertQuota(ctx, config);

    /** Identity CỐ ĐỊNH là `tooling` — adapter không có đường chọn khác (§12.2) */
    const client = await ctx.k8s.getClient("tooling");
    const secret = secretOf(config, ctx);
    // Secret trước: release không bao giờ trỏ tới một Secret chưa có
    if (secret !== null) await client.write("apply", secret.ref, secret.body);
    for (const unit of unitsFor(ctx)) {
      ctx.progress(`áp ${unit.chart.name} ${unit.chart.version}`);
      await client.write(
        "apply",
        valuesRef(unit, ctx),
        desiredOf(unit, config, ctx),
      );
      await client.write("apply", releaseRef(unit, ctx), releaseSpec(unit));
    }
    ctx.progress(`${spec.toolId} đã sẵn sàng`);
    return spec.bindings(ctx, config);
  }

  /**
   * Trôi của MỘT release — đọc CẢ HAI đối tượng đã ghi, không chỉ ConfigMap.
   *
   * [v4.10] Lưới E16 có một ô "xoá hẳn một Deployment", và trong mô hình mô phỏng của
   * §13.2 thì `HelmRelease` là đối tượng đại diện cho workload đang chạy. Bản trước chỉ đọc
   * ConfigMap giá trị, nên xoá release là một lần trôi KHÔNG bị phát hiện. Release đi kèm
   * mang tên nó trong `details`, để người vận hành biết phần nào của nhóm đã trôi.
   */
  async function unitDrift(
    client: ReadOnlyKubernetesClient,
    unit: HelmUnit,
    config: DomainToolConfig,
    ctx: ReadOnlyAdapterContext,
  ): Promise<{ drifted: boolean; details?: string }> {
    const prefix = unit.primary ? "" : `${unit.releaseName}: `;
    const ignored = spec.ignoredKeyPrefixes ?? [];
    const release = await client.read<Record<string, unknown>>(
      "get",
      releaseRef(unit, ctx),
    );
    if (release === null) {
      return { drifted: true, details: `${prefix}thiếu HelmRelease của tool` };
    }
    const releaseDrift = driftBetween(releaseSpec(unit), release, ignored);
    if (releaseDrift.drifted) {
      return {
        drifted: true,
        details: `${prefix}HelmRelease ${releaseDrift.details ?? "đã trôi"}`,
      };
    }
    const found = await client.read<Record<string, unknown>>(
      "get",
      valuesRef(unit, ctx),
    );
    if (found === null) {
      return {
        drifted: true,
        details: `${prefix}thiếu ConfigMap giá trị của release`,
      };
    }
    const valuesDrift = driftBetween(
      desiredOf(unit, config, ctx),
      found,
      ignored,
    );
    return valuesDrift.drifted && !unit.primary
      ? { drifted: true, details: `${prefix}${valuesDrift.details ?? ""}` }
      : valuesDrift;
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
  ): Promise<
    { status: "SUCCESS"; data: T } | { status: "FAILED"; message: string }
  > {
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
        for (const unit of unitsFor(ctx)) {
          const drift = await unitDrift(client, unit, config, ctx);
          if (drift.drifted) return drift;
        }
        const secret = secretOf(config, ctx);
        if (secret === null) return { drifted: false };
        /**
         * Secret bị xoá hay sửa tay cũng là trôi — agent mất khoá mà ConfigMap vẫn nguyên.
         * `details` chỉ nêu TÊN khoá (`driftBetween` không in giá trị), nên bí mật đọc lại
         * không rời bộ nhớ worker.
         */
        const stored = await client.read<Record<string, unknown>>(
          "get",
          secret.ref,
        );
        if (stored === null) {
          return { drifted: true, details: "thiếu Secret của release" };
        }
        const secretDrift = driftBetween(
          secret.body,
          stored,
          spec.ignoredKeyPrefixes ?? [],
        );
        return secretDrift.drifted
          ? { drifted: true, details: `Secret ${secretDrift.details ?? ""}` }
          : secretDrift;
      }),

    onDependencyChanged: (ctx, config, changed) =>
      guarded(async () => {
        const needed = spec.capabilities.requires.flatMap((r) =>
          "anyOf" in r ? r.anyOf.map((x) => x.id) : [r.id],
        );
        /** Capability không liên quan ⇒ no-op THÀNH CÔNG, và không ghi gì */
        if (!needed.includes(changed.id)) return undefined;
        /**
         * Áp lại giá trị của MỌI release với `resolved` MỚI.
         *
         * `values` đọc `ctx.resolved`, nên áp lại là cách duy nhất để endpoint mới đi vào giá
         * trị Helm — của release chính lẫn release đi kèm (bộ thu log trỏ tới sink). Sửa tay
         * một trường trong ConfigMap sẽ để release và ConfigMap lệch nhau.
         */
        const client = await ctx.k8s.getClient("tooling");
        const next = {
          ...ctx,
          resolved: { ...ctx.resolved, [changed.id]: changed },
        };
        for (const unit of unitsFor(ctx)) {
          await client.write("patch", valuesRef(unit, ctx), {
            values: unit.values(config, next),
          });
        }
        return undefined;
      }),

    healthcheck: (ctx) =>
      guarded(async () => {
        const client = await ctx.k8s.getClient("tooling");
        const missing: string[] = [];
        for (const unit of unitsFor(ctx)) {
          if ((await client.read("get", releaseRef(unit, ctx))) === null) {
            missing.push(unit.releaseName);
          }
        }
        /** Chưa cài ⇒ `healthy: false`, KHÔNG ném: Portal gọi hàm này ở mọi trạng thái */
        return missing.length === 0
          ? { healthy: true }
          : {
              healthy: false,
              details: `chưa có Helm release ${missing.join(", ")}`,
            };
      }),

    teardown: (ctx, reason) =>
      guarded(async () => {
        const client = await ctx.k8s.getClient("tooling");
        // Ngược thứ tự áp: bộ thu log và giao diện đi trước máy chủ lưu trữ; release nền giữ lại
        for (const unit of [...unitsFor(ctx)]
          .reverse()
          .filter((u) => !u.shared)) {
          await client.write("delete", releaseRef(unit, ctx));
          /**
           * `reason = "switch"` GIỮ ConfigMap giá trị.
           *
           * Đổi tool thì cấu hình cũ còn ích: người vận hành so được cái mới với cái cũ, và
           * một lần đổi ngược lại không mất thiết lập. Tắt domain hay xoá project thì dọn
           * sạch — §5.2 nói `reason` tồn tại đúng để phân biệt hai việc đó.
           */
          if (reason !== "switch") {
            await client.write("delete", valuesRef(unit, ctx));
          }
        }
        // Bí mật thì KHÔNG giữ kể cả khi đổi tool: khoá không sống lâu hơn tool dùng nó
        if (hasSecret) {
          await client.write("delete", secretRef(nsOf(ctx), secretName));
        }
        return undefined;
      }),
  };

  return adapter;
}
