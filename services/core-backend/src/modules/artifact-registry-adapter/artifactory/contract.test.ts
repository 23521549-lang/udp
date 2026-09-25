import { runDomainAdapterContract } from "@udp/adapter-core/contract";
import type { AdapterFixture } from "@udp/adapter-core";
import { domainContractEnv } from "@udp/adapter-core/testing";
import { describe, it } from "vitest";
import {
  HELM_IGNORED_PREFIXES,
  helmDriftMutations,
} from "../../adapter-base/contract-fixtures.js";
import adapter from "./index.js";

/** Artifactory qua đủ bộ hợp đồng (Plan #35 AC-1, AC-4) */

function fixture(): AdapterFixture {
  return {
    validConfig: {
      externalUrl: "https://artifacts.acme.dev",
      adminPassword: "canhArtifactoryP35",
      storageGb: 100,
    },
    invalidConfigs: [
      { externalUrl: "https://artifacts.acme.dev", adminPassword: "ngan" },
      { externalUrl: "ftp://x", adminPassword: "canhArtifactoryP35" },
    ],
    externalHosts: [],
    quotaDimensions: ["maxStorageGb", "maxLoadBalancers"],
    ignoredLabelPrefixes: HELM_IGNORED_PREFIXES,
    driftMutations: helmDriftMutations("udp-artifactory", { secrets: true }),
  };
}

describe("artifactory", () => {
  runDomainAdapterContract(adapter, () => domainContractEnv(fixture()), {
    describe,
    it,
  });
});
