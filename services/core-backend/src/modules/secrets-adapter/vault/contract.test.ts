import { runDomainAdapterContract } from "@udp/adapter-core/contract";
import type { AdapterFixture } from "@udp/adapter-core";
import { domainContractEnv } from "@udp/adapter-core/testing";
import { describe, it } from "vitest";
import {
  HELM_IGNORED_PREFIXES,
  helmDriftMutations,
} from "../../adapter-base/contract-fixtures.js";
import adapter from "./index.js";

/** HashiCorp Vault qua đủ bộ hợp đồng (Plan #34 AC-1): Raft trên PVC ⇒ maxStorageGb */

function fixture(): AdapterFixture {
  return {
    validConfig: { storageGb: 10, injector: true, csi: true },
    invalidConfigs: [{ storageGb: 0 }, { injector: "có" }],
    externalHosts: [],
    quotaDimensions: ["maxStorageGb"],
    ignoredLabelPrefixes: HELM_IGNORED_PREFIXES,
    driftMutations: helmDriftMutations("udp-vault"),
  };
}

describe("vault", () => {
  runDomainAdapterContract(adapter, () => domainContractEnv(fixture()), {
    describe,
    it,
  });
});
