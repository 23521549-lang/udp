import { runDomainAdapterContract } from "@udp/adapter-core/contract";
import type { AdapterFixture } from "@udp/adapter-core";
import { domainContractEnv } from "@udp/adapter-core/testing";
import { describe, expect, it } from "vitest";
import {
  HELM_IGNORED_PREFIXES,
  helmDriftMutations,
} from "../../adapter-base/contract-fixtures.js";
import adapter, { metricsSource } from "./index.js";

/** Grafana Cloud qua đủ bộ hợp đồng (Plan #31 AC-3); nguồn metrics là PromQL được host */

const URL_OK =
  "https://prometheus-prod-13-prod-ap-southeast-1.grafana.net/api/prom";
const TOKEN = `glc_${"eyJvIjoiMTIzNDU2Nzg5MCIsIm4iOiJ1ZHAifQ".repeat(2)}`;

function fixture(): AdapterFixture {
  const valid = { prometheusUrl: URL_OK, prometheusUser: 1234567 };
  return {
    validConfig: { ...valid, accessToken: TOKEN },
    invalidConfigs: [
      {
        ...valid,
        accessToken: TOKEN,
        prometheusUrl: "https://mimir.vi-du.test/api/prom",
      },
      { ...valid, accessToken: "glc_ngan" },
      { ...valid, accessToken: TOKEN, prometheusUser: -1 },
      { prometheusUrl: URL_OK, accessToken: TOKEN },
    ],
    externalHosts: [],
    quotaDimensions: [],
    ignoredLabelPrefixes: HELM_IGNORED_PREFIXES,
    driftMutations: helmDriftMutations("udp-grafana-cloud", { secrets: true }),
  };
}

describe("grafana-cloud", () => {
  runDomainAdapterContract(adapter, () => domainContractEnv(fixture()), {
    describe,
    it,
  });
});

describe("grafana-cloud — nguồn metrics", () => {
  it("PromQL ngoài cluster, basic auth bằng instance id + token", () => {
    expect(metricsSource.of(fixture().validConfig, {})).toEqual({
      kind: "prometheus",
      baseUrl: URL_OK,
      inCluster: false,
      basicAuth: { username: "1234567", password: TOKEN },
    });
  });
});
