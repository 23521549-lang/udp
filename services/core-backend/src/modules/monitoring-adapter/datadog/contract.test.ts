import { runDomainAdapterContract } from "@udp/adapter-core/contract";
import { readOnlyContext, type AdapterFixture } from "@udp/adapter-core";
import {
  CONTRACT_SYSTEM_NAMESPACE as SYSTEM_NS,
  domainContractEnv,
} from "@udp/adapter-core/testing";
import { describe, expect, it } from "vitest";
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

const API_HOST = "api.datadoghq.com";
/** Khoá GIẢ đúng định dạng — cũng là chuỗi canh: không được thấy ngoài header và Secret */
const API_KEY = "0123456789abcdef0123456789abcdef";
const APP_KEY = "fedcba9876543210fedcba9876543210fedcba98";

const connection = {
  apiVersion: "v1",
  kind: "ConfigMap",
  namespace: SYSTEM_NS,
  name: "udp-datadog-connection",
} as const;
const keySecret = {
  apiVersion: "v1",
  kind: "Secret",
  namespace: SYSTEM_NS,
  name: "udp-datadog-connection-key",
} as const;

function fixture(): AdapterFixture {
  const valid = { site: "datadoghq.com", apiKey: API_KEY, appKey: APP_KEY };
  return {
    validConfig: { ...valid, maxHosts: 50 },
    invalidConfigs: [
      /** `site` ngoài danh sách — một site gõ sai gửi dữ liệu sang vùng khác */
      { ...valid, site: "datadoghq.vn" },
      /** Khoá ứng dụng dán vào ô khoá API: sai độ dài, bắt trước khi Datadog trả 403 */
      { ...valid, apiKey: APP_KEY },
      /** Thiếu khoá: không có gì để xác thực */
      { site: "datadoghq.com", appKey: APP_KEY },
      /** Vượt trần host — gần như luôn là lỗi gõ, và nó là tiền của khách */
      { ...valid, maxHosts: 999_999 },
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
          await client.write("patch", connection, {
            apiHost: "api.datadoghq.eu",
          });
        },
      },
      {
        name: "xoá hẳn ConfigMap kết nối",
        apply: async (client) => {
          await client.write("delete", connection);
        },
      },
      {
        name: "xoá Secret khoá ingest (log shipper mất khoá, ConfigMap vẫn nguyên)",
        apply: async (client) => {
          await client.write("delete", keySecret);
        },
      },
    ],
  };
}

describe("datadog", () => {
  runDomainAdapterContract(adapter, () => domainContractEnv(fixture()), {
    describe,
    it,
  });
});

describe("datadog — khoá là bí mật (Plan #31 QĐ-5, QĐ-6)", () => {
  it("khoá đi trong header; thân request và ConfigMap không mang khoá; Secret chỉ có khoá ingest", async () => {
    const requests: { url: string; init: RequestInit | undefined }[] = [];
    const env = domainContractEnv(fixture(), { requests });
    const res = await adapter.deploy(env.context(), env.fixture.validConfig);
    expect(res.status).toBe("SUCCESS");

    const sent = requests[0]?.init;
    expect(sent?.headers).toMatchObject({
      "DD-API-KEY": API_KEY,
      "DD-APPLICATION-KEY": APP_KEY,
    });
    expect(String(sent?.body)).not.toContain(API_KEY);
    expect(String(sent?.body)).not.toContain(APP_KEY);

    const client = await env.cluster.getClient("tooling");
    const map = await client.read<Record<string, unknown>>("get", connection);
    expect(JSON.stringify(map)).not.toContain(API_KEY);
    expect(map).toMatchObject({
      secretName: keySecret.name,
      secretsDigest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
    });
    expect(await client.read("get", keySecret)).toEqual({
      type: "Opaque",
      stringData: { "api-key": API_KEY },
    });
    expect(env.progressLog.join(" | ")).not.toContain(API_KEY);
  });

  it("đổi khoá mà chưa áp ⇒ drift, và chi tiết drift không in khoá", async () => {
    const env = domainContractEnv(fixture());
    await adapter.deploy(env.context(), env.fixture.validConfig);
    const rotated = { ...env.fixture.validConfig, apiKey: "a".repeat(32) };
    const res = await adapter.detectDrift(
      readOnlyContext(env.context()),
      rotated,
    );
    expect(res.data?.drifted).toBe(true);
    expect(JSON.stringify(res)).not.toContain("a".repeat(32));
    expect(JSON.stringify(res)).not.toContain(API_KEY);
  });

  it("teardown xoá cả Secret khoá", async () => {
    const env = domainContractEnv(fixture());
    await adapter.deploy(env.context(), env.fixture.validConfig);
    await adapter.teardown(env.context(), "switch");
    const client = await env.cluster.getClient("tooling");
    expect(await client.read("get", keySecret)).toBeNull();
  });
});
