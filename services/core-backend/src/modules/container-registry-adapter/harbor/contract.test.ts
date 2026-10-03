import { runDomainAdapterContract } from "@udp/adapter-core/contract";
import type { AdapterFixture } from "@udp/adapter-core";
import { domainContractEnv } from "@udp/adapter-core/testing";
import { describe, it } from "vitest";
import {
  HELM_IGNORED_PREFIXES,
  helmDriftMutations,
} from "../../adapter-base/contract-fixtures.js";
import adapter from "./index.js";

/** Harbor qua đủ bộ hợp đồng (Plan #35 AC-1): mật khẩu admin là bí mật, PVC + LoadBalancer */

function fixture(): AdapterFixture {
  return {
    validConfig: {
      externalUrl: "https://harbor.acme.dev",
      adminPassword: "Canh-Harbor-P35",
      storageGb: 50,
    },
    invalidConfigs: [
      {
        externalUrl: "http://harbor.acme.dev",
        adminPassword: "Canh-Harbor-P35",
      },
      { externalUrl: "https://harbor.acme.dev", adminPassword: "yeu" },
    ],
    externalHosts: [],
    quotaDimensions: ["maxStorageGb", "maxLoadBalancers"],
    ignoredLabelPrefixes: HELM_IGNORED_PREFIXES,
    driftMutations: helmDriftMutations("udp-harbor", { secrets: true }),
  };
}

describe("harbor", () => {
  runDomainAdapterContract(adapter, () => domainContractEnv(fixture()), {
    describe,
    it,
  });
});
