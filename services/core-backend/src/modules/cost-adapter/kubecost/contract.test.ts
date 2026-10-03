import { runDomainAdapterContract } from "@udp/adapter-core/contract";
import type { AdapterFixture } from "@udp/adapter-core";
import { domainContractEnv } from "@udp/adapter-core/testing";
import { describe, it } from "vitest";
import {
  HELM_IGNORED_PREFIXES,
  helmDriftMutations,
} from "../../adapter-base/contract-fixtures.js";
import adapter from "./index.js";

/** Kubecost qua đủ bộ hợp đồng (Plan #38 AC-1) — hai environment của project hợp đồng */

const PROM = {
  id: "metrics.query",
  version: "2.0.0",
  providedBy: "monitoring:prometheus-grafana",
  endpoint: "http://udp-prometheus-prometheus.udp-system:9090",
} as const;

function fixture(): AdapterFixture {
  return {
    validConfig: { kubecostToken: "canhTokenKubecostP38" },
    invalidConfigs: [{ kubecostToken: "ngan" }, { kubecostToken: 5 }],
    externalHosts: [],
    quotaDimensions: [],
    ignoredLabelPrefixes: HELM_IGNORED_PREFIXES,
    driftMutations: helmDriftMutations("udp-kubecost", { secrets: true }),
  };
}

describe("kubecost", () => {
  runDomainAdapterContract(
    adapter,
    () => domainContractEnv(fixture(), { resolved: { "metrics.query": PROM } }),
    {
      describe,
      it,
    },
  );
});
