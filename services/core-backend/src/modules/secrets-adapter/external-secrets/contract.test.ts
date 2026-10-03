import { runDomainAdapterContract } from "@udp/adapter-core/contract";
import type { AdapterFixture } from "@udp/adapter-core";
import { domainContractEnv } from "@udp/adapter-core/testing";
import { describe, it } from "vitest";
import {
  HELM_IGNORED_PREFIXES,
  helmDriftMutations,
} from "../../adapter-base/contract-fixtures.js";
import adapter from "./index.js";

/** External Secrets Operator qua đủ bộ hợp đồng (Plan #34 AC-1) */

function fixture(): AdapterFixture {
  return {
    validConfig: { concurrent: 1, webhook: true },
    invalidConfigs: [{ concurrent: 0 }, { webhook: "có" }],
    externalHosts: [],
    quotaDimensions: [],
    ignoredLabelPrefixes: HELM_IGNORED_PREFIXES,
    driftMutations: helmDriftMutations("udp-external-secrets"),
  };
}

describe("external-secrets", () => {
  runDomainAdapterContract(adapter, () => domainContractEnv(fixture()), {
    describe,
    it,
  });
});
