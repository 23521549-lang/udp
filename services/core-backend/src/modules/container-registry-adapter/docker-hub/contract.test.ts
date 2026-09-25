import { runDomainAdapterContract } from "@udp/adapter-core/contract";
import type { AdapterFixture } from "@udp/adapter-core";
import { domainContractEnv } from "@udp/adapter-core/testing";
import { describe, it } from "vitest";
import {
  REGISTRY_IGNORED_PREFIXES,
  registryDriftMutations,
} from "../../adapter-base/contract-fixtures.js";
import adapter from "./index.js";

/** Docker Hub qua đủ bộ hợp đồng (Plan #35 AC-1) */

function fixture(): AdapterFixture {
  return {
    validConfig: {
      namespace: "acme",
      username: "acmebot",
      accessToken: "dckr_pat_canhTokenDockerP35abc",
    },
    invalidConfigs: [
      { namespace: "A" },
      { namespace: "acme", accessToken: "khong-phai-pat" },
    ],
    externalHosts: [],
    quotaDimensions: [],
    ignoredLabelPrefixes: REGISTRY_IGNORED_PREFIXES,
    driftMutations: registryDriftMutations("docker-hub"),
  };
}

describe("docker-hub", () => {
  runDomainAdapterContract(adapter, () => domainContractEnv(fixture()), {
    describe,
    it,
  });
});
