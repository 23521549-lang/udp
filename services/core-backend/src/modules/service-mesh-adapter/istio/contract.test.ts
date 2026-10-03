import { runDomainAdapterContract } from "@udp/adapter-core/contract";
import type { AdapterFixture } from "@udp/adapter-core";
import { domainContractEnv } from "@udp/adapter-core/testing";
import { describe, it } from "vitest";
import {
  HELM_IGNORED_PREFIXES,
  helmDriftMutations,
} from "../../adapter-base/contract-fixtures.js";
import adapter from "./index.js";

/** Istio qua đủ bộ hợp đồng (Plan #33 AC-1): ba release, gateway tiêu thụ maxLoadBalancers */

function fixture(): AdapterFixture {
  return {
    validConfig: { accessLog: false, tracingSamplingPercent: 1 },
    invalidConfigs: [{ tracingSamplingPercent: 150 }, { accessLog: "có" }],
    externalHosts: [],
    quotaDimensions: ["maxLoadBalancers"],
    ignoredLabelPrefixes: HELM_IGNORED_PREFIXES,
    driftMutations: helmDriftMutations("udp-istio-base", {
      companions: ["udp-istiod", "udp-istio-ingress"],
    }),
  };
}

describe("istio", () => {
  runDomainAdapterContract(adapter, () => domainContractEnv(fixture()), {
    describe,
    it,
  });
});
