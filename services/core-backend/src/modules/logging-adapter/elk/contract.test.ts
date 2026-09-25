import { runDomainAdapterContract } from "@udp/adapter-core/contract";
import type { AdapterFixture } from "@udp/adapter-core";
import { domainContractEnv } from "@udp/adapter-core/testing";
import { describe, it } from "vitest";
import {
  HELM_IGNORED_PREFIXES,
  helmDriftMutations,
} from "../../adapter-base/contract-fixtures.js";
import adapter from "./index.js";

/** ELK (ECK) qua đủ bộ hợp đồng (Plan #32 AC-1): operator + eck-stack, mật khẩu do ECK sinh */

function fixture(): AdapterFixture {
  return {
    validConfig: { nodeCount: 1, storageGb: 30, kibana: true },
    invalidConfigs: [{ nodeCount: 5 }, { storageGb: 0 }, { kibana: "có" }],
    externalHosts: [],
    quotaDimensions: ["maxStorageGb"],
    ignoredLabelPrefixes: HELM_IGNORED_PREFIXES,
    driftMutations: helmDriftMutations("udp-eck-operator", {
      companions: ["udp-elk"],
    }),
  };
}

describe("elk", () => {
  runDomainAdapterContract(adapter, () => domainContractEnv(fixture()), {
    describe,
    it,
  });
});
