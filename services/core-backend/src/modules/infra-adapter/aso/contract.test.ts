import { runDomainAdapterContract } from "@udp/adapter-core/contract";
import type { AdapterFixture } from "@udp/adapter-core";
import { domainContractEnv } from "@udp/adapter-core/testing";
import { describe, it } from "vitest";
import {
  HELM_IGNORED_PREFIXES,
  helmDriftMutations,
} from "../../adapter-base/contract-fixtures.js";
import adapter from "./index.js";

/** Azure Service Operator qua đủ bộ hợp đồng (Plan #37 AC-1) */

function fixture(): AdapterFixture {
  return {
    validConfig: {
      subscriptionId: "0f8fad5b-d9cb-469f-a165-70867728950e",
      tenantId: "0f8fad5b-d9cb-469f-a165-70867728950e",
      clientId: "0f8fad5b-d9cb-469f-a165-70867728950e",
    },
    invalidConfigs: [
      {
        subscriptionId: "khong-phai-uuid",
        tenantId: "0f8fad5b-d9cb-469f-a165-70867728950e",
        clientId: "0f8fad5b-d9cb-469f-a165-70867728950e",
      },
      {
        subscriptionId: "0f8fad5b-d9cb-469f-a165-70867728950e",
        tenantId: "0f8fad5b-d9cb-469f-a165-70867728950e",
        clientId: "0f8fad5b-d9cb-469f-a165-70867728950e",
        groups: [],
      },
    ],
    externalHosts: [],
    quotaDimensions: [],
    ignoredLabelPrefixes: HELM_IGNORED_PREFIXES,
    driftMutations: helmDriftMutations("udp-aso", {
      companions: ["udp-cert-manager"],
    }),
  };
}

describe("aso", () => {
  runDomainAdapterContract(adapter, () => domainContractEnv(fixture()), {
    describe,
    it,
  });
});
