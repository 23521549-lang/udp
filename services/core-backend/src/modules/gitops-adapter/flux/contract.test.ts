import { runDomainAdapterContract } from "@udp/adapter-core/contract";
import type { AdapterFixture } from "@udp/adapter-core";
import { domainContractEnv } from "@udp/adapter-core/testing";
import { describe, it } from "vitest";
import {
  HELM_IGNORED_PREFIXES,
  helmDriftMutations,
} from "../../adapter-base/contract-fixtures.js";
import adapter from "./index.js";

/** Flux qua đủ bộ hợp đồng (Plan #34 AC-1): flux2 + flux2-sync, token qua readsSecretValues */

function fixture(): AdapterFixture {
  return {
    validConfig: {
      repoUrl: "https://github.com/acme/platform-config",
      revision: "main",
      path: ".",
      token: "ghp_canhTokenP34abcdef0123456789",
    },
    invalidConfigs: [
      { repoUrl: "git@github.com:acme/x.git" },
      {
        repoUrl: "https://github.com/acme/platform-config",
        intervalMinutes: 0,
      },
    ],
    externalHosts: [],
    quotaDimensions: [],
    ignoredLabelPrefixes: HELM_IGNORED_PREFIXES,
    driftMutations: helmDriftMutations("udp-flux", {
      secrets: true,
      companions: ["udp-flux-sync"],
    }),
  };
}

describe("flux", () => {
  runDomainAdapterContract(adapter, () => domainContractEnv(fixture()), {
    describe,
    it,
  });
});
