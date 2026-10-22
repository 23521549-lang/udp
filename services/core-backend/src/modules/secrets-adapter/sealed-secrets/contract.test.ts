import { runDomainAdapterContract } from "@udp/adapter-core/contract";
import type { AdapterFixture } from "@udp/adapter-core";
import { domainContractEnv } from "@udp/adapter-core/testing";
import { describe, it } from "vitest";
import {
  HELM_IGNORED_PREFIXES,
  helmDriftMutations,
} from "../../adapter-base/contract-fixtures.js";
import adapter from "./index.js";

/** Sealed Secrets qua đủ bộ hợp đồng (Plan #34 AC-1) */

function fixture(): AdapterFixture {
  return {
    validConfig: { keyRenewDays: 30 },
    invalidConfigs: [{ keyRenewDays: -1 }, { keyRenewDays: 400 }],
    externalHosts: [],
    quotaDimensions: [],
    ignoredLabelPrefixes: HELM_IGNORED_PREFIXES,
    driftMutations: helmDriftMutations("udp-sealed-secrets"),
  };
}

describe("sealed-secrets", () => {
  runDomainAdapterContract(adapter, () => domainContractEnv(fixture()), {
    describe,
    it,
  });
});
