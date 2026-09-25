import { runDomainAdapterContract } from "@udp/adapter-core/contract";
import type { AdapterFixture } from "@udp/adapter-core";
import { domainContractEnv } from "@udp/adapter-core/testing";
import { describe, it } from "vitest";
import {
  REGISTRY_IGNORED_PREFIXES,
  registryDriftMutations,
} from "../../adapter-base/contract-fixtures.js";
import adapter from "./index.js";

/** AWS ECR qua đủ bộ hợp đồng (Plan #35 AC-1): kéo bằng định danh node, không Secret nào */

function fixture(): AdapterFixture {
  return {
    validConfig: {
      accountId: "123456789012",
      region: "ap-southeast-1",
      repositoryPrefix: "acme/web",
    },
    invalidConfigs: [
      { accountId: "123", region: "ap-southeast-1" },
      { accountId: "123456789012", region: "vung-la" },
      {
        accountId: "123456789012",
        region: "ap-southeast-1",
        repositoryPrefix: "Hoa Thuong",
      },
    ],
    externalHosts: [],
    quotaDimensions: [],
    ignoredLabelPrefixes: REGISTRY_IGNORED_PREFIXES,
    driftMutations: registryDriftMutations("ecr"),
  };
}

describe("ecr", () => {
  runDomainAdapterContract(adapter, () => domainContractEnv(fixture()), {
    describe,
    it,
  });
});
