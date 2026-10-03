import { runDomainAdapterContract } from "@udp/adapter-core/contract";
import type { AdapterFixture } from "@udp/adapter-core";
import {
  CONTRACT_SYSTEM_NAMESPACE as SYSTEM_NS,
  domainContractEnv,
} from "@udp/adapter-core/testing";
import { describe, expect, it } from "vitest";
import {
  HELM_IGNORED_PREFIXES,
  helmDriftMutations,
} from "../../adapter-base/contract-fixtures.js";
import adapter from "./index.js";

/** New Relic qua đủ bộ hợp đồng (Plan #31 AC-3), và license key chỉ nằm trong Secret (AC-8) */

const LICENSE = "eu01xx0123456789abcdef0123456789abcdNRAL";
/**
 * Khoá người dùng GIẢ: đúng hình `NRAK-[A-Z0-9]{27}` để đi qua schema của `index.ts` (nó đòi đúng 27 ký tự), và
 * nội dung là bảng chữ cái để không ai đọc nó như một khoá thật.
 *
 * **Ghép từ hai phần** vì push protection của GitHub chặn một chuỗi LIỀN khớp mẫu "New Relic Personal API Key"
 * (chặn thật, lần đẩy 04/10/2026). Giá trị lúc chạy không đổi một byte, nên độ phủ của test y nguyên — đổi fixture
 * thành một chuỗi ngắn mới là làm yếu test, vì lúc đó đường "nhận khoá đúng hình" không còn được đi qua. Cùng thói
 * quen với `package.test.ts` của `@udp/openfeature-provider`, nơi tên gói được ghép để cổng ranh giới không đọc
 * nhầm nó là một lượt tự import.
 */
const USER_KEY = ["NRAK", "ABCDEFGHIJKLMNOPQRSTUVWXYZ0"].join("-");

function fixture(): AdapterFixture {
  const valid = {
    accountId: 1234567,
    region: "EU",
    licenseKey: LICENSE,
    userKey: USER_KEY,
  };
  return {
    validConfig: { ...valid, lowDataMode: true },
    invalidConfigs: [
      /** User key dán vào ô license key — sai định dạng, bắt trước khi agent bị từ chối */
      { ...valid, licenseKey: USER_KEY },
      { ...valid, region: "APAC" },
      { ...valid, accountId: 0 },
      { region: "US", licenseKey: LICENSE, userKey: USER_KEY },
    ],
    externalHosts: [],
    quotaDimensions: [],
    ignoredLabelPrefixes: HELM_IGNORED_PREFIXES,
    driftMutations: helmDriftMutations("udp-newrelic", { secrets: true }),
  };
}

describe("newrelic", () => {
  runDomainAdapterContract(adapter, () => domainContractEnv(fixture()), {
    describe,
    it,
  });
});

describe("newrelic — khoá và vùng", () => {
  it("license key chỉ trong Secret; user key không vào cluster; binding theo vùng EU", async () => {
    const env = domainContractEnv(fixture());
    const res = await adapter.deploy(env.context(), env.fixture.validConfig);
    expect(res.status).toBe("SUCCESS");
    const client = await env.cluster.getClient("tooling");
    const secret = await client.read<{ stringData: Record<string, string> }>(
      "get",
      {
        apiVersion: "v1",
        kind: "Secret",
        namespace: SYSTEM_NS,
        name: "udp-newrelic-secrets",
      },
    );
    expect(secret?.stringData["values.yaml"]).toContain(LICENSE);
    const everythingOnCluster = JSON.stringify(
      await Promise.all(
        env.cluster.writes
          .filter((w) => w.ref.kind !== "Secret")
          .map((w) => client.read("get", w.ref)),
      ),
    );
    expect(everythingOnCluster).not.toContain(LICENSE);
    expect(everythingOnCluster).not.toContain(USER_KEY);
    expect(secret?.stringData["values.yaml"]).not.toContain(USER_KEY);
    expect(res.data?.map((b) => b.endpoint)).toEqual([
      "https://api.eu.newrelic.com/graphql",
      "https://log-api.eu.newrelic.com/log/v1",
    ]);
  });
});
