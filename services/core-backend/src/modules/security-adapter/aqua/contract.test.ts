import { runDomainAdapterContract } from "@udp/adapter-core/contract";
import type { AdapterFixture } from "@udp/adapter-core";
import { domainContractEnv } from "@udp/adapter-core/testing";
import { describe, it } from "vitest";
import {
  HELM_IGNORED_PREFIXES,
  helmDriftMutations,
} from "../../adapter-base/contract-fixtures.js";
import adapter from "./index.js";

/** Aqua Security qua đủ bộ hợp đồng (Plan #37 AC-1) */

function fixture(): AdapterFixture {
  return {
    validConfig: {
      gateway: "aqua-gateway.acme.dev:8443",
      enforcerToken: "canhTokenAquaP37abcdef",
    },
    invalidConfigs: [
      {
        gateway: "https://aqua.acme.dev",
        enforcerToken: "canhTokenAquaP37abcdef",
      },
      { gateway: "aqua.acme.dev:8443", enforcerToken: "ngan" },
    ],
    externalHosts: [],
    quotaDimensions: [],
    ignoredLabelPrefixes: HELM_IGNORED_PREFIXES,
    driftMutations: helmDriftMutations("udp-aqua", { secrets: true }),
  };
}

describe("aqua", () => {
  runDomainAdapterContract(adapter, () => domainContractEnv(fixture()), {
    describe,
    it,
  });
});
