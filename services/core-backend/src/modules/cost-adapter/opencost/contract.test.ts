import { runDomainAdapterContract } from "@udp/adapter-core/contract";
import type { AdapterFixture } from "@udp/adapter-core";
import { domainContractEnv } from "@udp/adapter-core/testing";
import { describe, it } from "vitest";
import {
  HELM_IGNORED_PREFIXES,
  helmDriftMutations,
} from "../../adapter-base/contract-fixtures.js";
import adapter from "./index.js";

/** OpenCost qua đủ bộ hợp đồng (Plan #38 AC-1) — hai environment của project hợp đồng */

const PROM = {
  id: "metrics.query",
  version: "2.0.0",
  providedBy: "monitoring:prometheus-grafana",
  endpoint: "http://udp-prometheus-prometheus.udp-system:9090",
} as const;

function fixture(): AdapterFixture {
  return {
    validConfig: { pricing: "custom", cpuHourlyUsd: 0.04 },
    invalidConfigs: [{ pricing: "free" }, { cpuHourlyUsd: -1 }],
    externalHosts: [],
    quotaDimensions: [],
    ignoredLabelPrefixes: HELM_IGNORED_PREFIXES,
    driftMutations: helmDriftMutations("udp-opencost"),
  };
}

describe("opencost", () => {
  runDomainAdapterContract(
    adapter,
    () => domainContractEnv(fixture(), { resolved: { "metrics.query": PROM } }),
    {
      describe,
      it,
    },
  );
});
