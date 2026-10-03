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

/** Flagger qua đủ bộ hợp đồng (Plan #33 AC-1, AC-4): Istio + Prometheus, webhook Slack là bí mật */

const PROM = {
  id: "metrics.query",
  version: "2.0.0",
  providedBy: "monitoring:prometheus-grafana",
  endpoint: "http://udp-prometheus-prometheus.udp-system:9090",
} as const;

function fixture(): AdapterFixture {
  return {
    validConfig: {
      slackWebhook: "https://hooks.slack.com/services/T000/B000/XXXX",
    },
    invalidConfigs: [
      { slackWebhook: "https://ke-gian.vi-du.test/hook" },
      { slackWebhook: 42 },
    ],
    externalHosts: [],
    quotaDimensions: [],
    ignoredLabelPrefixes: HELM_IGNORED_PREFIXES,
    driftMutations: helmDriftMutations("udp-flagger", { secrets: true }),
  };
}

describe("flagger", () => {
  runDomainAdapterContract(
    adapter,
    () =>
      domainContractEnv(fixture(), {
        resolved: {
          "mesh.traffic-split": trafficSplitBinding(
            "mesh.traffic-split",
            "service_mesh:istio",
            "istio",
          ),
          "metrics.query": PROM,
        },
      }),
    {
      describe,
      it,
    },
  );
});
