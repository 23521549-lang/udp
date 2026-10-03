import { runDomainAdapterContract } from "@udp/adapter-core/contract";
import type { AdapterFixture } from "@udp/adapter-core";
import { domainContractEnv } from "@udp/adapter-core/testing";
import { describe, it } from "vitest";
import {
  HELM_IGNORED_PREFIXES,
  helmDriftMutations,
} from "../../adapter-base/contract-fixtures.js";
import adapter from "./index.js";

/** Datadog Logs (Agent) qua đủ bộ hợp đồng (Plan #32 AC-1) */

function fixture(): AdapterFixture {
  return {
    validConfig: {
      site: "datadoghq.com",
      apiKey: "0123456789abcdef0123456789abcdef",
    },
    invalidConfigs: [
      { site: "datadoghq.vn", apiKey: "0123456789abcdef0123456789abcdef" },
      { site: "datadoghq.com", apiKey: "ngan" },
      { site: "datadoghq.com" },
    ],
    externalHosts: [],
    quotaDimensions: [],
    ignoredLabelPrefixes: HELM_IGNORED_PREFIXES,
    driftMutations: helmDriftMutations("udp-datadog-logs", { secrets: true }),
  };
}

describe("datadog-logs", () => {
  runDomainAdapterContract(adapter, () => domainContractEnv(fixture()), {
    describe,
    it,
  });
});
