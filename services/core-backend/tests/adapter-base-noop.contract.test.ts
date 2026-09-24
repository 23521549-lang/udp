import {
  DOMAIN_CONTRACT_CHECKS,
  type DomainContractEnv,
} from "@udp/adapter-core/contract";
import type {
  AdapterFixture,
  DomainAdapter,
  DomainAdapterContext,
} from "@udp/adapter-core";
import { createFakeClusterAccess } from "@udp/adapter-core/testing";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createHelmBasedAdapter } from "../src/modules/adapter-base/helm.js";
import { createSaaSAdapter } from "../src/modules/adapter-base/saas.js";

/**
 * [v4.10] Cổng P19+P20 — **bốn** adapter qua đủ bộ hợp đồng, và **0** lần nới lỏng.
 *
 * Hai adapter thật (`prometheus-grafana`, `datadog`) có bộ test cạnh chúng. Hai adapter
 * dưới đây là bản TỐI THIỂU của mỗi họ, và chúng trả lời một câu khác hai adapter thật:
 *
 *  - Adapter thật chứng minh **lớp nền chạy được với dữ liệu thật**.
 *  - Adapter tối thiểu chứng minh **lớp nền không đòi hỏi gì thừa**: một adapter mới chỉ
 *    cần khai đúng những trường bắt buộc là đã qua được 42 phép. Nếu lớp nền âm thầm phụ
 *    thuộc một trường tuỳ chọn, hai adapter này đỏ trong khi hai adapter thật vẫn xanh.
 *
 * **Vì sao chúng nằm dưới `tests/` chứ không trong `src/modules/*-adapter/`:** một adapter
 * noop trong cây sản phẩm là một tool mà registry tìm thấy, Portal hiện lên, và người dùng
 * bật được — một tool không làm gì. Cùng lý lẽ với quyết định ở P17: fixture sống dưới
 * `tests/`, và registry sản phẩm không bao giờ thấy chúng.
 */

const SYSTEM_NS = "udp-system";
const NOOP_HOST = "api.vi-du-noop.test";

/** Schema tối thiểu: đúng một trường bắt buộc */
const noopSchema = z.object({ enabled: z.boolean() });

function noopHelmAdapter(): DomainAdapter {
  return createHelmBasedAdapter({
    domainType: "LOGGING",
    toolId: "noop-helm",
    version: "0.1.0",
    scope: "cluster",
    /** Chỉ `provides`, không `requires` — nhánh đơn giản nhất của đồ thị capability */
    capabilities: {
      provides: [{ id: "logs.sink", version: "1.0.0" }],
      requires: [],
    },
    configSchema: noopSchema,
    chart: { name: "noop", version: "0.1.0", repo: "https://vi-du.test/charts" },
    releaseName: "udp-noop-helm",
    /** RỖNG ⇒ bộ hợp đồng đòi nó chạy được với quota toàn 0 */
    quotaDimensions: [],
    values: (config) => ({ enabled: noopSchema.parse(config).enabled }),
    bindings: (ctx) => [
      {
        id: "logs.sink",
        version: "1.0.0",
        providedBy: "logging:noop-helm",
        endpoint: `http://noop.${ctx.systemNamespace}:80`,
      },
    ],
  });
}

function noopSaaSAdapter(): DomainAdapter {
  return createSaaSAdapter({
    domainType: "TRACING",
    toolId: "noop-saas",
    version: "0.1.0",
    capabilities: {
      provides: [{ id: "traces.sink", version: "1.0.0" }],
      requires: [],
    },
    configSchema: noopSchema,
    apiHost: NOOP_HOST,
    connectionName: "udp-noop-saas-connection",
    quotaDimensions: [],
    configurePath: () => "/v1/configure",
    configureBody: (config) => ({ enabled: noopSchema.parse(config).enabled }),
    bindings: () => [
      {
        id: "traces.sink",
        version: "1.0.0",
        providedBy: "tracing:noop-saas",
        endpoint: `https://${NOOP_HOST}/v1/traces`,
      },
    ],
  });
}

function fixtureFor(kind: "helm" | "saas"): AdapterFixture {
  const name =
    kind === "helm" ? "udp-noop-helm-values" : "udp-noop-saas-connection";
  return {
    validConfig: { enabled: true },
    invalidConfigs: [{ enabled: "co" }, {}, { enabled: 1 }],
    /** Họ Helm không gọi ra ngoài; họ SaaS gọi đúng một host */
    externalHosts: kind === "helm" ? [] : [NOOP_HOST],
    quotaDimensions: [],
    /** RỖNG ⇒ bộ hợp đồng đòi MỌI khác biệt nhãn đều là drift */
    ignoredLabelPrefixes: [],
    driftMutations: [
      {
        name: `sửa tay ConfigMap ${name}`,
        apply: async (client) => {
          await client.write(
            "patch",
            {
              apiVersion: "v1",
              kind: "ConfigMap",
              namespace: SYSTEM_NS,
              name,
            },
            { provider: "ai-do-sua-tay" },
          );
        },
      },
    ],
  };
}

function envFor(kind: "helm" | "saas"): DomainContractEnv {
  const cluster = createFakeClusterAccess({ clusterId: `c-noop-${kind}` });
  const progressLog: string[] = [];
  const fetchLog: string[] = [];

  const context = (
    over: Partial<DomainAdapterContext> = {},
  ): DomainAdapterContext => ({
    k8s: cluster,
    systemNamespace: SYSTEM_NS,
    region: "ap-southeast-1",
    quota: {
      maxNodes: 3,
      maxNodeSize: "medium",
      maxDatabases: 2,
      maxStorageGb: 50,
      maxLoadBalancers: 3,
    },
    resolved: {},
    tags: {},
    progress: (m) => progressLog.push(m),
    fetch: (input) => {
      const url = String(input);
      fetchLog.push(url);
      if (kind === "helm") {
        /** Họ Helm khai `externalHosts` rỗng, nên mọi lời gọi là một vi phạm */
        return Promise.reject(new Error("egress không được phép"));
      }
      let host = "";
      try {
        host = new URL(url).host;
      } catch {
        host = "";
      }
      if (host !== NOOP_HOST) {
        return Promise.reject(new Error(`egress tới ${host} bị từ chối`));
      }
      return Promise.resolve(new Response("{}", { status: 200 }));
    },
    ...over,
  });

  return { cluster, fixture: fixtureFor(kind), context, progressLog, fetchLog };
}

for (const [label, make, kind] of [
  ["noop-helm", noopHelmAdapter, "helm"],
  ["noop-saas", noopSaaSAdapter, "saas"],
] as const) {
  describe(`adapter tối thiểu: ${label}`, () => {
    for (const check of DOMAIN_CONTRACT_CHECKS) {
      it(check.name, async () => {
        await check.run(make(), envFor(kind));
      });
    }
  });
}

/**
 * Meta — **0 lần nới lỏng**, và con số đó là một kết quả của luận văn.
 *
 * §13.2: *"số lần phải nới lỏng chính là số liệu báo cáo ở E1"*. Bốn adapter thuộc hai họ
 * khác nhau về căn bản (một cài chart và không gọi ra ngoài; một không cài gì và chỉ gọi
 * API) đi qua cùng 42 phép mà không phép nào phải nới lỏng. Đó là dạng bằng chứng mà luận
 * điểm pluggable cần: không phải "khung linh hoạt" mà "bốn hiện thực, một bộ test, không
 * ngoại lệ".
 */
describe("meta — cổng P19+P20", () => {
  it("số nới lỏng là 0, khớp docs/E1-relaxations.json", async () => {
    const { CONTRACT_RELAXATIONS } = await import("@udp/adapter-core/contract");
    expect(CONTRACT_RELAXATIONS).toEqual([]);
  });

  it("mỗi adapter tối thiểu chạy đủ 42 phép", () => {
    /**
     * Con số đi từ chính danh sách, không viết tay lần thứ hai: vòng `for` ở trên sinh ra
     * đúng `DOMAIN_CONTRACT_CHECKS.length` phép cho mỗi adapter, nên khẳng định ở đây là
     * khẳng định về danh sách.
     */
    expect(DOMAIN_CONTRACT_CHECKS).toHaveLength(42);
  });
});
