import { runDomainAdapterContract } from "@udp/adapter-core/contract";
import type { AdapterFixture } from "@udp/adapter-core";
import { domainContractEnv } from "@udp/adapter-core/testing";
import { describe, it } from "vitest";
import {
  DESCRIPTOR_IGNORED_PREFIXES,
  registryDriftMutations,
} from "../../adapter-base/contract-fixtures.js";
import adapter from "./index.js";

/** GHCR qua đủ bộ hợp đồng (Plan #35 AC-1) */

function fixture(): AdapterFixture {
  return {
    validConfig: {
      owner: "Acme",
      username: "acme-bot",
      token: "ghp_" + "a".repeat(36),
    },
    invalidConfigs: [{ owner: "-acme" }, { owner: "acme", token: "ghp_ngan" }],
    externalHosts: [],
    quotaDimensions: [],
    ignoredLabelPrefixes: DESCRIPTOR_IGNORED_PREFIXES,
    driftMutations: registryDriftMutations("ghcr"),
  };
}

describe("ghcr", () => {
  runDomainAdapterContract(adapter, () => domainContractEnv(fixture()), {
    describe,
    it,
  });
});
