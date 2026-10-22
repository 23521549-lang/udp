import { runDomainAdapterContract } from "@udp/adapter-core/contract";
import type { AdapterFixture } from "@udp/adapter-core";
import { domainContractEnv } from "@udp/adapter-core/testing";
import { describe, it } from "vitest";
import {
  HELM_IGNORED_PREFIXES,
  helmDriftMutations,
} from "../../adapter-base/contract-fixtures.js";
import adapter from "./index.js";

/** Argo CD qua đủ bộ hợp đồng (Plan #34 AC-1): repo riêng tư, token là bí mật */

function fixture(): AdapterFixture {
  return {
    validConfig: {
      repoUrl: "https://github.com/acme/platform-config",
      revision: "main",
      path: "clusters/prod",
      token: "ghp_canhTokenP34abcdef0123456789",
      syncPolicy: "automated",
    },
    invalidConfigs: [
      { repoUrl: "http://github.com/acme/x" },
      { repoUrl: "ssh://git@github.com/acme/x" },
      {
        repoUrl: "https://github.com/acme/platform-config",
        revision: "main; rm -rf",
      },
      { repoUrl: "https://github.com/acme/platform-config", token: "ngan" },
    ],
    externalHosts: [],
    quotaDimensions: [],
    ignoredLabelPrefixes: HELM_IGNORED_PREFIXES,
    driftMutations: helmDriftMutations("udp-argocd", { secrets: true }),
  };
}

describe("argo-cd", () => {
  runDomainAdapterContract(adapter, () => domainContractEnv(fixture()), {
    describe,
    it,
  });
});
