import { runDomainAdapterContract } from "@udp/adapter-core/contract";
import type { AdapterFixture } from "@udp/adapter-core";
import { domainContractEnv } from "@udp/adapter-core/testing";
import { describe, it } from "vitest";
import {
  HELM_IGNORED_PREFIXES,
  helmDriftMutations,
} from "../../adapter-base/contract-fixtures.js";
import adapter from "./index.js";

/** Tempo qua đủ bộ hợp đồng (Plan #31 AC-3); block trace trên PVC ⇒ tiêu thụ maxStorageGb */

function fixture(): AdapterFixture {
  return {
    validConfig: { retentionHours: 72, storageGb: 10 },
    invalidConfigs: [
      { retentionHours: 0 },
      { retentionHours: 72, storageGb: 5000 },
      { retentionHours: "ba ngày" },
    ],
    externalHosts: [],
    quotaDimensions: ["maxStorageGb"],
    ignoredLabelPrefixes: HELM_IGNORED_PREFIXES,
    driftMutations: helmDriftMutations("udp-tempo"),
  };
}

describe("tempo", () => {
  runDomainAdapterContract(adapter, () => domainContractEnv(fixture()), {
    describe,
    it,
  });
});
