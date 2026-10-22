import { runDomainAdapterContract } from "@udp/adapter-core/contract";
import type { AdapterFixture } from "@udp/adapter-core";
import { domainContractEnv } from "@udp/adapter-core/testing";
import { describe, expect, it } from "vitest";
import {
  HELM_IGNORED_PREFIXES,
  helmDriftMutations,
} from "../../adapter-base/contract-fixtures.js";
import adapter from "./index.js";

/** Dynatrace qua đủ bộ hợp đồng (Plan #31 AC-3); chỉ nhận miền SaaS của Dynatrace */

const token = (c: string) => `dt0c01.${c.repeat(24)}.${c.repeat(64)}`;

function fixture(): AdapterFixture {
  const valid = {
    environmentUrl: "https://abc12345.live.dynatrace.com",
    apiToken: token("A"),
    dataIngestToken: token("B"),
  };
  return {
    validConfig: { ...valid, mode: "cloudNativeFullStack" },
    invalidConfigs: [
      /** Miền tự do là một đường gửi khoá của khách tới máy bất kỳ */
      { ...valid, environmentUrl: "https://dynatrace.vi-du.test" },
      { ...valid, environmentUrl: "http://abc12345.live.dynatrace.com" },
      { ...valid, apiToken: "dt0c01.ngan" },
      { ...valid, mode: "hostOnly" },
    ],
    externalHosts: [],
    quotaDimensions: [],
    ignoredLabelPrefixes: HELM_IGNORED_PREFIXES,
    driftMutations: helmDriftMutations("udp-dynatrace", { secrets: true }),
  };
}

describe("dynatrace", () => {
  runDomainAdapterContract(adapter, () => domainContractEnv(fixture()), {
    describe,
    it,
  });
});

describe("dynatrace — endpoint theo environment", () => {
  it("ba binding trỏ đúng environment của khách", async () => {
    const env = domainContractEnv(fixture());
    const res = await adapter.deploy(env.context(), env.fixture.validConfig);
    expect(res.data?.map((b) => `${b.id} ${String(b.endpoint)}`)).toEqual([
      "metrics.query https://abc12345.live.dynatrace.com/api/v2/metrics/query",
      "logs.sink https://abc12345.live.dynatrace.com/api/v2/logs/ingest",
      "traces.sink https://abc12345.live.dynatrace.com/api/v2/otlp/v1/traces",
    ]);
  });
});
