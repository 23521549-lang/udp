import { z } from "zod";
import type { CapabilityBinding } from "@udp/shared-types";
import type { AdapterFixture, DomainAdapter } from "../domain.js";
import { refKey } from "./fake-cluster.js";

/**
 * [v4.10] Một Domain Adapter GIẢ đi qua trọn bộ `DOMAIN_CONTRACT_CHECKS`.
 *
 * Nó tồn tại để trả lời một câu hỏi mà không phép kiểm nào khác trả lời được: **bộ hợp
 * đồng có thoả được không?** Một bộ 41 phép mà không hiện thực nào qua nổi là một bộ vô
 * dụng theo cách khó thấy — nó sẽ được đọc như "tiêu chuẩn cao", trong khi thật ra nó
 * chứa hai phép loại trừ nhau. Adapter này là bằng chứng ngược lại, và nó cũng là khuôn
 * cho hai adapter thật của P19/P20.
 *
 * Nó KHÔNG phải một mock: nó ghi đối tượng thật lên cluster giả, đọc lại khi so drift, và
 * từ chối đúng những thứ hợp đồng đòi nó từ chối. Một mock trả `SUCCESS` cho mọi thứ sẽ
 * đỏ ở phần lớn 41 phép.
 *
 * **Nguồn ngẫu nhiên là một BỘ ĐẾM LÊN, không phải `Math.random`.** Adapter thật cần một
 * chuỗi ngẫu nhiên cho tên release; ở đây nó đếm lên, nên hai lượt chạy cho cùng một kết
 * quả và một lần đỏ tái tạo được. Dùng `Math.random()` (hay `randomUUID`) làm `deploy`
 * sinh tên khác nhau mỗi lượt, và phép "deploy hai lần là idempotent" sẽ đỏ hoặc xanh tuỳ
 * lần chạy.
 */

const CONFIG_KIND = "ConfigMap";
const RELEASE_KIND = "HelmRelease";

export const fakeAdapterConfigSchema = z.object({
  /** Retention tính theo ngày; số âm là ca `invalidConfigs` */
  retentionDays: z.number().int().positive(),
  /** Có bật dashboard hay không */
  dashboards: z.boolean().default(true),
});

export interface FakeDomainAdapterOptions {
  /** Giá trị khởi đầu của bộ đếm — hai lượt chạy khác seed vẫn xác định */
  seed?: number;
}

/**
 * Bộ đếm LÊN thay cho nguồn ngẫu nhiên.
 *
 * Trả về chuỗi hex ngắn, tăng dần. Đủ để đặt tên tài nguyên khác nhau trong một lượt, và
 * **xác định** giữa các lượt — điều kiện để phép idempotent có nghĩa.
 */
export function countingRandom(seed = 0): () => string {
  let n = seed;
  return () => {
    n += 1;
    return n.toString(16).padStart(4, "0");
  };
}

export function createFakeDomainAdapter(
  options: FakeDomainAdapterOptions = {},
): DomainAdapter {
  const nextId = countingRandom(options.seed ?? 0);
  /** Nội dung mong muốn của ConfigMap — `detectDrift` so với chính nó */
  let desired: Record<string, unknown> = {};

  const nsOf = (ctx: Parameters<DomainAdapter["deploy"]>[0]): string =>
    ctx.environment?.k8sNamespace ?? ctx.systemNamespace;

  const bindingsOf = (endpoint: string): CapabilityBinding[] => [
    {
      id: "metrics.query",
      version: "2.0.0",
      providedBy: "monitoring:fake-monitoring",
      endpoint,
    },
  ];

  async function apply(
    ctx: Parameters<DomainAdapter["deploy"]>[0],
    config: Parameters<DomainAdapter["deploy"]>[1],
  ): Promise<CapabilityBinding[]> {
    const parsed = fakeAdapterConfigSchema.safeParse(config);
    if (!parsed.success) {
      throw new Error("config không hợp lệ theo configSchema");
    }
    /**
     * Ba lý do từ chối, và cả ba là hợp đồng chứ không phải sự khó tính:
     *
     *  - `quota.maxStorageGb === 0`: adapter này khai tiêu thụ chiều đó, nên chạy với 0
     *    là hứa một thứ nó không giữ được.
     *  - `resolved["registry.oci"]` vắng: nó `requires` capability đó, và tự đoán endpoint
     *    là lỗi vỡ ngay khi người dùng đổi provider.
     *  - `__forceFailWith`: cửa của phép kiểm "không rò secret ra thông điệp lỗi".
     */
    if (ctx.quota.maxStorageGb <= 0) {
      throw new Error("vượt quota: maxStorageGb phải lớn hơn 0");
    }
    if (ctx.resolved["registry.oci"] === undefined) {
      throw new Error("thiếu binding registry.oci trong ctx.resolved");
    }
    if (typeof config["__forceFailWith"] === "string") {
      /** Thông điệp KHÔNG mang giá trị được truyền vào — đó là điều đang được kiểm */
      throw new Error("deploy thất bại theo yêu cầu của test");
    }

    ctx.progress("bắt đầu áp cấu hình");
    const client = await ctx.k8s.getClient("tooling");
    const ns = nsOf(ctx);

    desired = {
      retentionDays: parsed.data.retentionDays,
      dashboards: parsed.data.dashboards,
    };

    /**
     * Tên tài nguyên KHÔNG mang chuỗi đếm.
     *
     * Bộ đếm dùng cho những thứ thật sự phải khác nhau trong một lượt; tên ConfigMap thì
     * phải **ổn định**, vì `deploy` hai lần là idempotent nghĩa là lần hai ghi lại đúng
     * đối tượng đó chứ không tạo thêm một cái mới.
     */
    await client.write(
      "apply",
      { apiVersion: "v1", kind: CONFIG_KIND, namespace: ns, name: "fake-config" },
      desired,
    );
    await client.write(
      "apply",
      { apiVersion: "helm.sh/v1", kind: RELEASE_KIND, namespace: ns, name: "fake-release" },
      { chartVersion: "1.2.3", revision: nextId() },
    );
    ctx.progress("đã áp cấu hình");
    return bindingsOf(`http://fake-monitoring.${ns}:9090`);
  }

  const adapter: DomainAdapter = {
    domainType: "MONITORING",
    toolId: "fake-monitoring",
    version: "1.2.3",
    scope: "cluster",
    capabilities: {
      provides: [{ id: "metrics.query", version: "2.0.0" }],
      requires: [{ id: "registry.oci" }],
      recommends: ["logs.sink"],
      hint: { "registry.oci": "Bật domain Container Registry" },
    },
    configSchema: fakeAdapterConfigSchema,

    async deploy(ctx, config) {
      try {
        return { status: "SUCCESS", data: await apply(ctx, config) };
      } catch (err) {
        return {
          status: "FAILED",
          message: err instanceof Error ? err.message : "lỗi không rõ",
        };
      }
    },

    async configure(ctx, config) {
      return await this.deploy(ctx, config);
    },

    async upgrade(ctx, config, fromVersion) {
      /**
       * `fromVersion` lạ ⇒ TỪ CHỐI.
       *
       * Nâng cấp là một đường di trú: không biết đang ở đâu thì không biết phải chạy bước
       * nào. Đoán ở đây là cách một lần upgrade "thành công" để lại một release nửa vời.
       */
      if (fromVersion !== adapter.version) {
        return {
          status: "FAILED",
          message: `không biết đường nâng cấp từ ${fromVersion}`,
        };
      }
      return await this.deploy(ctx, config);
    },

    async detectDrift(ctx, config) {
      const parsed = fakeAdapterConfigSchema.safeParse(config);
      if (!parsed.success) {
        return { status: "FAILED", message: "config không hợp lệ" };
      }
      /**
       * Nhận client rồi CHỈ đọc.
       *
       * Bảo đảm tầng kiểu là chữ ký `ReadOnlyKubernetesClient` ở §4.6; ở đây adapter tự
       * giữ kỷ luật đó, và bộ hợp đồng đếm `writes` để kỷ luật ấy không phải một lời hứa.
       */
      const client = await ctx.k8s.getClient("tooling");
      const found = await client.read<Record<string, unknown>>("get", {
        apiVersion: "v1",
        kind: CONFIG_KIND,
        namespace: nsOf(ctx),
        name: "fake-config",
      });
      if (found === null) {
        return { status: "SUCCESS", data: { drifted: true, details: "thiếu ConfigMap" } };
      }
      const drifted = Object.entries(desired).some(
        ([k, v]) => found[k] !== v,
      );
      return {
        status: "SUCCESS",
        data: drifted
          ? { drifted, details: "ConfigMap khác cấu hình mong muốn" }
          : { drifted },
      };
    },

    async onDependencyChanged(ctx, config, changed) {
      /** Capability không liên quan ⇒ no-op THÀNH CÔNG, không phải lỗi */
      if (changed.id !== "registry.oci") return { status: "SUCCESS" };
      const client = await ctx.k8s.getClient("tooling");
      await client.write(
        "patch",
        {
          apiVersion: "v1",
          kind: CONFIG_KIND,
          namespace: nsOf(ctx),
          name: "fake-config",
        },
        { registry: changed.endpoint ?? changed.providedBy },
      );
      void config;
      return { status: "SUCCESS" };
    },

    async healthcheck(ctx) {
      const client = await ctx.k8s.getClient("tooling");
      const found = await client.read("get", {
        apiVersion: "helm.sh/v1",
        kind: RELEASE_KIND,
        namespace: nsOf(ctx),
        name: "fake-release",
      });
      /** Chưa cài gì ⇒ `healthy: false`, KHÔNG ném: Portal gọi hàm này ở mọi trạng thái */
      return { status: "SUCCESS", data: { healthy: found !== null } };
    },

    async teardown(ctx, reason) {
      const client = await ctx.k8s.getClient("tooling");
      const ns = nsOf(ctx);
      /**
       * Xoá cả hai đối tượng, và `delete` một thứ đã biến mất là THÀNH CÔNG.
       *
       * Cùng lý lẽ với RUN9 của `CloudAdapterRunner`: compensation chạy lại phải idempotent,
       * nên `teardown` hai lần liên tiếp đều `SUCCESS`.
       */
      await client.write("delete", {
        apiVersion: "helm.sh/v1",
        kind: RELEASE_KIND,
        namespace: ns,
        name: "fake-release",
      });
      /** `reason = "switch"` giữ dữ liệu; ở đây ConfigMap không phải dữ liệu nên xoá luôn */
      void reason;
      await client.write("delete", {
        apiVersion: "v1",
        kind: CONFIG_KIND,
        namespace: ns,
        name: "fake-config",
      });
      return { status: "SUCCESS" };
    },
  };

  return adapter;
}

/**
 * `AdapterFixture` của adapter giả — khai bề mặt tác dụng TƯỜNG MINH (SPEC §2.5).
 *
 * `externalHosts` RỖNG là một khẳng định mạnh, không phải một chỗ trống: nó nói adapter
 * này không gọi ra ngoài, và bộ hợp đồng biến điều đó thành "mọi lời gọi egress là đỏ".
 */
export function fakeAdapterFixture(): AdapterFixture {
  return {
    validConfig: { retentionDays: 15, dashboards: true },
    invalidConfigs: [
      { retentionDays: -1 },
      { retentionDays: "mười lăm" },
      { dashboards: true },
    ],
    externalHosts: [],
    quotaDimensions: ["maxStorageGb"],
    ignoredLabelPrefixes: [
      {
        prefix: "kubectl.kubernetes.io/",
        reason: "kubectl tự thêm last-applied-configuration, không phải drift của ta",
      },
    ],
    driftMutations: [
      {
        name: "sửa tay retentionDays trên ConfigMap",
        apply: async (client) => {
          await client.write(
            "patch",
            {
              apiVersion: "v1",
              kind: CONFIG_KIND,
              namespace: "udp-system",
              name: "fake-config",
            },
            { retentionDays: 999 },
          );
        },
      },
      {
        name: "xoá hẳn ConfigMap",
        apply: async (client) => {
          await client.write("delete", {
            apiVersion: "v1",
            kind: CONFIG_KIND,
            namespace: "udp-system",
            name: "fake-config",
          });
        },
      },
    ],
  };
}

export { refKey };
