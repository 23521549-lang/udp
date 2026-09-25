import { runDomainAdapterContract } from "@udp/adapter-core/contract";
import type { AdapterFixture } from "@udp/adapter-core";
import { domainContractEnv } from "@udp/adapter-core/testing";
import { describe, it } from "vitest";
import {
  REGISTRY_IGNORED_PREFIXES,
  registryDriftMutations,
} from "../../adapter-base/contract-fixtures.js";
import adapter from "./index.js";

/** GitHub Packages qua đủ bộ hợp đồng (Plan #35 AC-1, AC-4): packages.store + registry.oci */

function fixture(): AdapterFixture {
  return {
    validConfig: { owner: "acme", token: "ghp_" + "a".repeat(36) },
    invalidConfigs: [{ owner: "acme_" }, { owner: "acme", token: "sai" }],
    externalHosts: [],
    quotaDimensions: [],
    ignoredLabelPrefixes: REGISTRY_IGNORED_PREFIXES,
    driftMutations: registryDriftMutations("github-packages"),
  };
}

describe("github-packages", () => {
  runDomainAdapterContract(adapter, () => domainContractEnv(fixture()), {
    describe,
    it,
  });
});
