import { runDomainAdapterContract } from "@udp/adapter-core/contract";
import type { AdapterFixture } from "@udp/adapter-core";
import { domainContractEnv } from "@udp/adapter-core/testing";
import { describe, it } from "vitest";
import {
  REGISTRY_IGNORED_PREFIXES,
  registryDriftMutations,
} from "../../adapter-base/contract-fixtures.js";
import adapter from "./index.js";

/** GCP Artifact Registry qua đủ bộ hợp đồng (Plan #35 AC-1) */

function fixture(): AdapterFixture {
  return {
    validConfig: {
      projectId: "acme-prod-01",
      location: "asia-southeast1",
      repository: "web",
    },
    invalidConfigs: [
      { projectId: "A", location: "us", repository: "web" },
      { projectId: "acme-prod-01", location: "mars", repository: "web" },
    ],
    externalHosts: [],
    quotaDimensions: [],
    ignoredLabelPrefixes: REGISTRY_IGNORED_PREFIXES,
    driftMutations: registryDriftMutations("gcp-artifact-registry"),
  };
}

describe("gcp-artifact-registry", () => {
  runDomainAdapterContract(adapter, () => domainContractEnv(fixture()), {
    describe,
    it,
  });
});
