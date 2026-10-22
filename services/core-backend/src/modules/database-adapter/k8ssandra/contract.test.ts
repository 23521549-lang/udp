import { runDomainAdapterContract } from "@udp/adapter-core/contract";
import type { AdapterFixture } from "@udp/adapter-core";
import { domainContractEnv } from "@udp/adapter-core/testing";
import { describe, it } from "vitest";
import {
  HELM_IGNORED_PREFIXES,
  helmDriftMutations,
} from "../../adapter-base/contract-fixtures.js";
import adapter from "./index.js";

/** K8ssandra qua đủ bộ hợp đồng (Plan #38 AC-1) — hai environment của project hợp đồng */

function fixture(): AdapterFixture {
  return {
    validConfig: { storageGb: 10 },
    invalidConfigs: [{ storageGb: 1000 }, { cassandraVersion: "3.11" }],
    externalHosts: [],
    quotaDimensions: ["maxDatabases", "maxStorageGb"],
    ignoredLabelPrefixes: HELM_IGNORED_PREFIXES,
    driftMutations: helmDriftMutations("udp-k8ssandra", {
      companions: [
        "udp-cert-manager",
        "udp-cassandra-dev",
        "udp-cassandra-prod",
      ],
    }),
  };
}

describe("k8ssandra", () => {
  runDomainAdapterContract(adapter, () => domainContractEnv(fixture()), {
    describe,
    it,
  });
});
