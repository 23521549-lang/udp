import { runDomainAdapterContract } from "@udp/adapter-core/contract";
import type { AdapterFixture } from "@udp/adapter-core";
import { domainContractEnv } from "@udp/adapter-core/testing";
import { describe, it } from "vitest";
import {
  HELM_IGNORED_PREFIXES,
  helmDriftMutations,
} from "../../adapter-base/contract-fixtures.js";
import { trafficSplitBinding } from "../../adapter-base/traffic-router.js";
import adapter from "./index.js";

/** Argo Rollouts qua đủ bộ hợp đồng (Plan #33 AC-1, AC-4): Kuma qua plugin Gateway API, Datadog (>=1) */

const DATADOG = {
  id: "metrics.query",
  version: "1.0.0",
  providedBy: "monitoring:datadog",
  endpoint: "https://api.datadoghq.com/api/v1/query",
} as const;

function fixture(): AdapterFixture {
  return {
    validConfig: { dashboard: true },
    invalidConfigs: [{ dashboard: "có" }],
    externalHosts: [],
    quotaDimensions: [],
    ignoredLabelPrefixes: HELM_IGNORED_PREFIXES,
    driftMutations: helmDriftMutations("udp-argo-rollouts"),
  };
}

describe("argo-rollouts", () => {
  runDomainAdapterContract(
    adapter,
    () =>
      domainContractEnv(fixture(), {
        resolved: {
          "metrics.query": DATADOG,
          "mesh.traffic-split": trafficSplitBinding(
            "mesh.traffic-split",
            "service_mesh:kuma",
            "kuma",
          ),
        },
      }),
    {
      describe,
      it,
    },
  );
});
