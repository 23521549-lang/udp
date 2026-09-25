import { runDomainAdapterContract } from "@udp/adapter-core/contract";
import type { AdapterFixture } from "@udp/adapter-core";
import { domainContractEnv } from "@udp/adapter-core/testing";
import { describe, it } from "vitest";
import {
  HELM_IGNORED_PREFIXES,
  helmDriftMutations,
} from "../../adapter-base/contract-fixtures.js";
import adapter from "./index.js";

/** Kyverno qua đủ bộ hợp đồng (Plan #34 AC-1): engine + bộ Pod Security Standards */

function fixture(): AdapterFixture {
  return {
    validConfig: {
      podSecurityStandard: "baseline",
      validationFailureAction: "Audit",
      replicas: 1,
    },
    invalidConfigs: [
      { podSecurityStandard: "privileged" },
      { validationFailureAction: "Deny" },
    ],
    externalHosts: [],
    quotaDimensions: [],
    ignoredLabelPrefixes: HELM_IGNORED_PREFIXES,
    driftMutations: helmDriftMutations("udp-kyverno", {
      companions: ["udp-kyverno-policies"],
    }),
  };
}

describe("kyverno", () => {
  runDomainAdapterContract(adapter, () => domainContractEnv(fixture()), {
    describe,
    it,
  });
});
