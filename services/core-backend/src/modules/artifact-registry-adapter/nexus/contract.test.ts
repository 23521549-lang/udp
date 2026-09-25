import { runDomainAdapterContract } from "@udp/adapter-core/contract";
import type { AdapterFixture } from "@udp/adapter-core";
import { domainContractEnv } from "@udp/adapter-core/testing";
import { describe, it } from "vitest";
import {
  HELM_IGNORED_PREFIXES,
  helmDriftMutations,
} from "../../adapter-base/contract-fixtures.js";
import adapter from "./index.js";

/** Nexus Repository qua đủ bộ hợp đồng (Plan #35 AC-1, AC-4) */

function fixture(): AdapterFixture {
  return {
    validConfig: {
      externalUrl: "https://nexus.acme.dev",
      adminPassword: "canhNexusAdminP35",
      storageGb: 100,
      dockerPort: 8082,
    },
    invalidConfigs: [
      {
        externalUrl: "https://nexus.acme.dev",
        adminPassword: "canhNexusAdminP35",
        dockerPort: 80,
      },
      { externalUrl: "https://nexus.acme.dev", adminPassword: "ngan" },
    ],
    externalHosts: [],
    quotaDimensions: ["maxStorageGb"],
    ignoredLabelPrefixes: HELM_IGNORED_PREFIXES,
    driftMutations: helmDriftMutations("udp-nexus", { secrets: true }),
  };
}

describe("nexus", () => {
  runDomainAdapterContract(adapter, () => domainContractEnv(fixture()), {
    describe,
    it,
  });
});
