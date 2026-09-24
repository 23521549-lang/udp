import {
  runDomainAdapterContract,
  type DomainContractEnv,
} from "@udp/adapter-core/contract";
import type { AdapterFixture, DomainAdapterContext } from "@udp/adapter-core";
import { createFakeClusterAccess } from "@udp/adapter-core/testing";
import { describe, it } from "vitest";
import adapter from "./index.js";

/**
 * [v4.10] Bộ hợp đồng cho adapter họ SaaS — và nó là NHÁNH ĐẢO của fixture Prometheus.
 *
 * Hai adapter thật cố tình khai ngược nhau ở hai danh sách, để cả hai nhánh của luật
 * "khai rỗng ⇒ phép kiểm đảo chiều" đều được chạy ít nhất một lần:
 *
 * | Danh sách | Prometheus | Datadog |
 * | --- | --- | --- |
 * | `externalHosts` | **RỖNG** ⇒ mọi egress là đỏ | có `api.datadoghq.com` ⇒ chỉ host đó |
 * | `quotaDimensions` | có `maxStorageGb` ⇒ phải từ chối khi = 0 | **RỖNG** ⇒ phải chạy với quota toàn 0 |
 *
 * Nếu cả hai adapter khai giống nhau thì bốn ô đảo chiều của bộ hợp đồng chỉ được chạy ở
 * một phía, và phía kia là mã chưa từng thực thi.
 */

const SYSTEM_NS = "udp-system";
const API_HOST = "api.datadoghq.com";

function fixture(): AdapterFixture {
  return {
    validConfig: {
      site: "datadoghq.com",
      credentialRef: "cred-datadog-1",
      maxHosts: 50,
    },
    invalidConfigs: [
      /** `site` ngoài danh sách — một site gõ sai gửi dữ liệu sang vùng khác */
      { site: "datadoghq.vn", credentialRef: "c", maxHosts: 50 },
      /** `credentialRef` rỗng: không có khoá nào để dùng */
      { site: "datadoghq.com", credentialRef: "", maxHosts: 50 },
      /** Thiếu trường bắt buộc */
      { maxHosts: 50 },
      /** Vượt trần host — gần như luôn là lỗi gõ, và nó là tiền của khách */
      { site: "datadoghq.com", credentialRef: "c", maxHosts: 999_999 },
    ],
    /** KHÁC Prometheus: adapter này PHẢI gọi ra ngoài, và chỉ tới đúng host này */
    externalHosts: [API_HOST],
    /** RỖNG: Datadog không tiêu thụ quota cluster nào ⇒ phải chạy với quota toàn 0 */
    quotaDimensions: [],
    ignoredLabelPrefixes: [
      {
        prefix: "kubectl.kubernetes.io/",
        reason:
          "kubectl tự thêm last-applied-configuration khi ai đó apply bằng tay",
      },
    ],
    driftMutations: [
      {
        name: "sửa tay site trong ConfigMap kết nối",
        apply: async (client) => {
          await client.write(
            "patch",
            {
              apiVersion: "v1",
              kind: "ConfigMap",
              namespace: SYSTEM_NS,
              name: "udp-datadog-connection",
            },
            { apiHost: "api.datadoghq.eu" },
          );
        },
      },
      {
        name: "xoá hẳn ConfigMap kết nối",
        apply: async (client) => {
          await client.write("delete", {
            apiVersion: "v1",
            kind: "ConfigMap",
            namespace: SYSTEM_NS,
            name: "udp-datadog-connection",
          });
        },
      },
    ],
  };
}

function envFor(): DomainContractEnv {
  const cluster = createFakeClusterAccess({ clusterId: "c-p20" });
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
    tags: { "udp.project": "p20" },
    progress: (m) => progressLog.push(m),
    /**
     * Egress guard GIẢ: cho qua đúng host đã khai, từ chối mọi host khác.
     *
     * Khác env của Prometheus (ném với mọi lời gọi) vì adapter này khai `externalHosts`
     * không rỗng. Trả về một `Response` thật chứ không một object giả: lớp nền đọc
     * `res.ok` và `res.status`, nên một object thiếu hai trường đó sẽ làm adapter vỡ ở một
     * chỗ không liên quan tới điều đang kiểm.
     */
    fetch: (input) => {
      const url = String(input);
      fetchLog.push(url);
      let host = "";
      try {
        host = new URL(url).host;
      } catch {
        host = "";
      }
      if (host !== API_HOST) {
        return Promise.reject(
          new Error(`egress tới ${host} bị egress guard từ chối`),
        );
      }
      return Promise.resolve(
        new Response(JSON.stringify({ ok: true }), { status: 200 }),
      );
    },
    ...over,
  });

  return { cluster, fixture: fixture(), context, progressLog, fetchLog };
}

describe("datadog", () => {
  runDomainAdapterContract(adapter, envFor(), {
    describe,
    it: (name, fn) => {
      void fn;
      it(name, async () => {
        const { DOMAIN_CONTRACT_CHECKS } =
          await import("@udp/adapter-core/contract");
        const check = DOMAIN_CONTRACT_CHECKS.find((c) => c.name === name);
        if (check === undefined) throw new Error(`không có phép "${name}"`);
        await check.run(adapter, envFor());
      });
    },
  });
});
