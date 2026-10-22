import { runDomainAdapterContract } from "@udp/adapter-core/contract";
import type { AdapterFixture } from "@udp/adapter-core";
import { domainContractEnv } from "@udp/adapter-core/testing";
import { describe, it } from "vitest";
import {
  HELM_IGNORED_PREFIXES,
  helmDriftMutations,
} from "../../adapter-base/contract-fixtures.js";
import adapter from "./index.js";

/** Consul Connect qua đủ bộ hợp đồng (Plan #33 AC-1): Raft trên PVC ⇒ maxStorageGb */

function fixture(): AdapterFixture {
  return {
    validConfig: { servers: 1, storageGb: 10 },
    invalidConfigs: [{ servers: 2 }, { storageGb: 0 }],
    externalHosts: [],
    quotaDimensions: ["maxStorageGb"],
    ignoredLabelPrefixes: HELM_IGNORED_PREFIXES,
    driftMutations: helmDriftMutations("udp-consul"),
  };
}

describe("consul-connect", () => {
  runDomainAdapterContract(adapter, () => domainContractEnv(fixture()), {
    describe,
    it,
  });
});
