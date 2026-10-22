import { runDomainAdapterContract } from "@udp/adapter-core/contract";
import type { AdapterFixture } from "@udp/adapter-core";
import { domainContractEnv } from "@udp/adapter-core/testing";
import { describe, it } from "vitest";
import {
  HELM_IGNORED_PREFIXES,
  helmDriftMutations,
} from "../../adapter-base/contract-fixtures.js";
import adapter from "./index.js";

/** Spinnaker qua đủ bộ hợp đồng (Plan #33 AC-1): Kayenta trên PromQL, MinIO trên PVC */

const PROM = {
  id: "metrics.query",
  version: "2.0.0",
  providedBy: "monitoring:prometheus-grafana",
  endpoint: "http://udp-prometheus-prometheus.udp-system:9090",
} as const;

function fixture(): AdapterFixture {
  return {
    validConfig: { storageGb: 20, kayenta: true },
    invalidConfigs: [{ storageGb: 1 }, { kayenta: "có" }],
    externalHosts: [],
    quotaDimensions: ["maxStorageGb"],
    ignoredLabelPrefixes: HELM_IGNORED_PREFIXES,
    driftMutations: helmDriftMutations("udp-spinnaker"),
  };
}

describe("spinnaker", () => {
  runDomainAdapterContract(
    adapter,
    () =>
      domainContractEnv(fixture(), {
        resolved: { "metrics.query": PROM },
      }),
    {
      describe,
      it,
    },
  );
});
