import { runDomainAdapterContract } from "@udp/adapter-core/contract";
import type { AdapterFixture } from "@udp/adapter-core";
import { domainContractEnv } from "@udp/adapter-core/testing";
import { describe, it } from "vitest";
import {
  DESCRIPTOR_IGNORED_PREFIXES,
  registryDriftMutations,
} from "../../adapter-base/contract-fixtures.js";
import adapter from "./index.js";

/** Azure Container Registry qua đủ bộ hợp đồng (Plan #35 AC-1): token pull là bí mật */

function fixture(): AdapterFixture {
  return {
    validConfig: {
      registryName: "acmeprod",
      tokenName: "udp-pull",
      tokenPassword: "canhMatKhauAcrP35xyz",
    },
    invalidConfigs: [
      { registryName: "Acme-Prod" },
      { registryName: "acmeprod", tokenPassword: "ngan" },
    ],
    externalHosts: [],
    quotaDimensions: [],
    ignoredLabelPrefixes: DESCRIPTOR_IGNORED_PREFIXES,
    driftMutations: registryDriftMutations("acr"),
  };
}

describe("acr", () => {
  runDomainAdapterContract(adapter, () => domainContractEnv(fixture()), {
    describe,
    it,
  });
});
