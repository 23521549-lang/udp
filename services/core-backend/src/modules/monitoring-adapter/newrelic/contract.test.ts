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
const USER_KEY = "NRAK-ABCDEFGHIJKLMNOPQRSTUVWXYZ0";

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
