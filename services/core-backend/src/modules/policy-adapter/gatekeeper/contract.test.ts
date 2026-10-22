import { runDomainAdapterContract } from "@udp/adapter-core/contract";
import type { AdapterFixture } from "@udp/adapter-core";
import { domainContractEnv } from "@udp/adapter-core/testing";
import { describe, it } from "vitest";
import {
  HELM_IGNORED_PREFIXES,
  helmDriftMutations,
} from "../../adapter-base/contract-fixtures.js";
import adapter from "./index.js";

/** OPA Gatekeeper qua đủ bộ hợp đồng (Plan #34 AC-1) */

function fixture(): AdapterFixture {
  return {
    validConfig: {
      replicas: 1,
      auditIntervalSeconds: 60,
      failurePolicy: "Ignore",
    },
    invalidConfigs: [
      { replicas: 0 },
      { auditIntervalSeconds: 5 },
      { failurePolicy: "Block" },
    ],
    externalHosts: [],
    quotaDimensions: [],
    ignoredLabelPrefixes: HELM_IGNORED_PREFIXES,
    driftMutations: helmDriftMutations("udp-gatekeeper"),
  };
}

describe("gatekeeper", () => {
  runDomainAdapterContract(adapter, () => domainContractEnv(fixture()), {
    describe,
    it,
  });
});
