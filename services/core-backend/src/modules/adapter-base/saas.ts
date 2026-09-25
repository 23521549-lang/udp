import type {
  CapabilityDeclaration,
  CapabilityBinding,
} from "@udp/shared-types";
import type {
  DomainAdapter,
  DomainAdapterContext,
  DomainToolConfig,
  ReadOnlyAdapterContext,
} from "@udp/adapter-core";
import type { ZodType } from "zod";
import { secretRef, toolSecret, type ToolSecret } from "./cluster-secret.js";

/**
 * [v4.10] `SaaSAdapter` — lớp nền cho họ adapter cấu hình một dịch vụ NGOÀI cluster (§5.2).
 *
 * Khác họ Helm ở chỗ căn bản: không có gì được cài vào cluster. Datadog, New Relic,
 * Splunk... đã chạy sẵn ở nhà cung cấp; việc của adapter là **cấu hình** chúng qua API và
 * để lại trong cluster đúng một thứ — nơi workload đọc được endpoint và tên secret.
 *
 * **`deploy()` = `configure()` (D-18), và đây là một bản sửa mâu thuẫn của tài liệu.**
 * §5.2 nói `SaaSAdapter` chỉ viết `configure()`, còn §13.2 lại gọi `deploy()`. Nếu để
 * nguyên thì bộ hợp đồng gọi một phương thức mà họ SaaS không hiện thực, và mọi adapter
 * SaaS đỏ ở phép đầu tiên. Chốt: lớp nền hiện thực `deploy()` **bằng cách gọi**
 * `configure()`, nên bộ hợp đồng có đúng MỘT điểm vào cho cả hai họ.
 *
 * **Ba điều lớp nền này cưỡng chế:**
 *
 *  1. **Mọi lời gọi ra ngoài đi qua `ctx.fetch`.** Lớp nền không bao giờ chạm `fetch` toàn
 *     cục, và một khối lint chặn nó trong cả thư mục adapter.
 *  2. **Khoá API không vào ConfigMap hay thân request.** Nó đi trong header do
 *     `authHeaders` khai, và phần workload cần thì vào `Secret` (Plan #31 QĐ-5, QĐ-6);
 *     ConfigMap chỉ mang TÊN secret và băm của nó.
 *  3. **`teardown` KHÔNG xoá tài khoản ở nhà cung cấp.** Xem chú thích tại chỗ.
 */

export interface SaaSAdapterSpec {
  domainType: DomainAdapter["domainType"];
  toolId: string;
  version: string;
  capabilities: CapabilityDeclaration;
  configSchema: ZodType;
  /** Host API của nhà cung cấp — phải khớp `externalHosts` của `AdapterFixture` */
  apiHost: string;
  /** Tên ConfigMap để lại trong cluster cho workload đọc */
  connectionName: string;
  /** Đường dẫn API để cấu hình; lớp nền gọi nó qua `ctx.fetch` */
  configurePath: (config: DomainToolConfig) => string;
  /** Thân request gửi lên nhà cung cấp */
  configureBody: (
    config: DomainToolConfig,
    ctx: ReadOnlyAdapterContext,
  ) => Record<string, unknown>;
  /** Header xác thực với nhà cung cấp, từ bí mật đã mở của config (Plan #31 QĐ-6) */
  authHeaders?: (config: DomainToolConfig) => Record<string, string>;
  /**
   * Khoá mà workload trong cluster cần (ví dụ khoá ingest của log shipper): lớp nền ghi
   * vào `Secret` `<connectionName>-key` trong `udp-system`, KHÔNG vào ConfigMap kết nối.
   */
  secretValues?: (config: DomainToolConfig) => Record<string, string>;
  /** Binding mà adapter cung cấp sau khi cấu hình xong */
  bindings: (ctx: ReadOnlyAdapterContext) => CapabilityBinding[];
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

const CONNECTION_KIND = "ConfigMap";

export class SaaSAdapterError extends Error {
  readonly code = "SAAS_ADAPTER_FAILED";
  constructor(message: string) {
    super(message);
    this.name = "SaaSAdapterError";
  }
}

export function createSaaSAdapter(spec: SaaSAdapterSpec): DomainAdapter {
  /**
   * Họ SaaS luôn `cluster`-scoped.
   *
   * Một tài khoản Datadog phục vụ cả project; dựng một cấu hình cho mỗi environment là
   * nhân số lần gọi API mà không thêm sự cô lập nào — dữ liệu vẫn nằm chung một tài khoản.
   */
  const nsOf = (ctx: ReadOnlyAdapterContext): string => ctx.systemNamespace;

  const connectionRef = (ctx: ReadOnlyAdapterContext) => ({
    apiVersion: "v1",
    kind: CONNECTION_KIND,
    namespace: nsOf(ctx),
    name: spec.connectionName,
  });

  const secretName = `${spec.connectionName}-key`;
  const secretOf = (
    config: DomainToolConfig,
    ctx: ReadOnlyAdapterContext,
  ): ToolSecret | null =>
    spec.secretValues === undefined
      ? null
      : toolSecret(nsOf(ctx), secretName, spec.secretValues(config));

  function desiredOf(
    config: DomainToolConfig,
    ctx: ReadOnlyAdapterContext,
  ): Record<string, unknown> {
    const secret = secretOf(config, ctx);
    return {
      provider: spec.toolId,
      apiHost: spec.apiHost,
      /**
       * TÊN secret và băm, KHÔNG phải giá trị: workload đọc ConfigMap này để biết mount
       * secret nào, còn giá trị chỉ nằm trong `Secret` (Plan #31 QĐ-5).
       */
      ...(secret === null ? {} : { secretName, secretsDigest: secret.digest }),
      settings: spec.configureBody(config, ctx),
    };
  }

  function assertQuota(ctx: DomainAdapterContext): void {
    for (const dim of spec.quotaDimensions) {
      const value = ctx.quota[dim];
      if (typeof value === "number" && value <= 0) {
        throw new SaaSAdapterError(
          `vượt quota: ${String(dim)} phải lớn hơn 0 cho ${spec.toolId}`,
        );
      }
    }
  }

  async function configureProvider(
    ctx: DomainAdapterContext,
    config: DomainToolConfig,
  ): Promise<CapabilityBinding[]> {
    const parsed = spec.configSchema.safeParse(config);
    if (!parsed.success) {
      throw new SaaSAdapterError(
        `config không hợp lệ theo configSchema của ${spec.toolId}`,
      );
    }
    assertQuota(ctx);

    ctx.progress(`cấu hình ${spec.toolId} qua API`);
    /**
     * `ctx.fetch`, KHÔNG phải `fetch` toàn cục.
     *
     * Đó là egress guard chống SSRF của §12 T11, và nó là lý do `AdapterFixture` phải khai
     * `externalHosts`: bộ hợp đồng đối chiếu host thật gọi với danh sách đã khai, nên một
     * adapter gọi thêm một host lạ bị bắt.
     */
    const res = await ctx.fetch(
      `https://${spec.apiHost}${spec.configurePath(config)}`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...spec.authHeaders?.(config),
        },
        body: JSON.stringify(spec.configureBody(config, ctx)),
      },
    );
    if (!res.ok) {
      /** Thông điệp KHÔNG mang thân response: nó có thể vọng lại khoá đã gửi */
      throw new SaaSAdapterError(
        `${spec.toolId} trả ${String(res.status)} khi cấu hình`,
      );
    }

    const client = await ctx.k8s.getClient("tooling");
    const secret = secretOf(config, ctx);
    if (secret !== null) await client.write("apply", secret.ref, secret.body);
    await client.write("apply", connectionRef(ctx), desiredOf(config, ctx));
    ctx.progress(`${spec.toolId} đã cấu hình`);
    return spec.bindings(ctx);
  }

  async function guarded<T>(
    fn: () => Promise<T>,
  ): Promise<
    { status: "SUCCESS"; data: T } | { status: "FAILED"; message: string }
  > {
    try {
      return { status: "SUCCESS", data: await fn() };
    } catch (err) {
      if (err instanceof SaaSAdapterError) {
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
    scope: "cluster",
    capabilities: spec.capabilities,
    configSchema: spec.configSchema,

    /** D-18: `deploy()` GỌI `configure()`, nên bộ hợp đồng có một điểm vào duy nhất */
    deploy(ctx, config) {
      return this.configure(ctx, config);
    },

    configure: (ctx, config) => guarded(() => configureProvider(ctx, config)),

    upgrade: (ctx, config, fromVersion) =>
      guarded(async () => {
        if (fromVersion !== spec.version) {
          throw new SaaSAdapterError(
            `không biết đường nâng cấp ${spec.toolId} từ ${fromVersion}`,
          );
        }
        return await configureProvider(ctx, config);
      }),

    detectDrift: (ctx, config) =>
      guarded(async () => {
        const parsed = spec.configSchema.safeParse(config);
        if (!parsed.success) {
          throw new SaaSAdapterError("config không hợp lệ theo configSchema");
        }
        /**
         * So với ConfigMap trong cluster, KHÔNG gọi API nhà cung cấp.
         *
         * Hai lý do, và lý do thứ hai mới là lý do thật: một lời gọi API mỗi lần quét
         * drift là hàng nghìn lời gọi mỗi ngày trên hạn mức của khách; và `detectDrift`
         * nhận client CHỈ ĐỌC (I32 chiều c), nên nó cũng không nên có tác dụng ra ngoài.
         * Cái nó phát hiện là "ai đó sửa tay cấu hình kết nối trong cluster" — chính là
         * dạng drift mà UDP chịu trách nhiệm.
         */
        const client = await ctx.k8s.getClient("tooling");
        const found = await client.read<Record<string, unknown>>(
          "get",
          connectionRef(ctx),
        );
        if (found === null) {
          return { drifted: true, details: "thiếu ConfigMap kết nối" };
        }
        const connectionDrift = driftBetween(
          desiredOf(config, ctx),
          found,
          spec.ignoredKeyPrefixes ?? [],
        );
        const secret = secretOf(config, ctx);
        if (connectionDrift.drifted || secret === null) return connectionDrift;
        /** Như lớp nền Helm: Secret mất hay bị sửa là trôi; `details` chỉ nêu TÊN khoá */
        const stored = await client.read<Record<string, unknown>>(
          "get",
          secret.ref,
        );
        if (stored === null) {
          return { drifted: true, details: "thiếu Secret kết nối" };
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
        if (!needed.includes(changed.id)) return undefined;
        const client = await ctx.k8s.getClient("tooling");
        await client.write("patch", connectionRef(ctx), {
          settings: spec.configureBody(config, {
            ...ctx,
            resolved: { ...ctx.resolved, [changed.id]: changed },
          }),
        });
        return undefined;
      }),

    healthcheck: (ctx) =>
      guarded(async () => {
        const client = await ctx.k8s.getClient("tooling");
        const found = await client.read("get", connectionRef(ctx));
        return found === null
          ? { healthy: false, details: "chưa cấu hình kết nối" }
          : { healthy: true };
      }),

    teardown: (ctx, reason) =>
      guarded(async () => {
        const client = await ctx.k8s.getClient("tooling");
        /**
         * Xoá ConfigMap kết nối, và **KHÔNG** xoá tài khoản ở nhà cung cấp.
         *
         * Đây là một quyết định, không phải một thiếu sót. Tài khoản Datadog là của KHÁCH:
         * nó có dữ liệu lịch sử, có hoá đơn, và có thể đang được dùng cho những thứ ngoài
         * UDP. Một `teardown` xoá nó là xoá dữ liệu mà UDP không sở hữu, và không có đường
         * hoàn lại. UDP chỉ tháo phần nó dựng.
         *
         * `reason` không đổi hành vi ở họ SaaS: không có "dữ liệu giữ lại" nào trong
         * cluster để phân biệt, vì dữ liệu nằm ở nhà cung cấp.
         */
        void reason;
        await client.write("delete", connectionRef(ctx));
        if (spec.secretValues !== undefined) {
          await client.write("delete", secretRef(nsOf(ctx), secretName));
        }
        return undefined;
      }),
  };

  return adapter;
}
