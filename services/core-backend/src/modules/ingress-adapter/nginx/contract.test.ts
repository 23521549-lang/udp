import { runDomainAdapterContract } from "@udp/adapter-core/contract";
import type { AdapterFixture } from "@udp/adapter-core";
import { domainContractEnv } from "@udp/adapter-core/testing";
import { describe, it } from "vitest";
import {
  HELM_IGNORED_PREFIXES,
  helmDriftMutations,
} from "../../adapter-base/contract-fixtures.js";
import adapter from "./index.js";

/** NGINX Ingress qua đủ bộ hợp đồng (Plan #33 AC-1): LoadBalancer ⇒ maxLoadBalancers */

function fixture(): AdapterFixture {
  return {
    validConfig: { replicas: 2, ingressClass: "nginx" },
    invalidConfigs: [{ replicas: 0 }, { ingressClass: "Khong Hop Le" }],
    externalHosts: [],
    quotaDimensions: ["maxLoadBalancers"],
    ignoredLabelPrefixes: HELM_IGNORED_PREFIXES,
    driftMutations: helmDriftMutations("udp-ingress-nginx"),
  };
}

describe("nginx", () => {
  runDomainAdapterContract(adapter, () => domainContractEnv(fixture()), {
    describe,
    it,
  });
});
