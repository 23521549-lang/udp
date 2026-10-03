import { runDomainAdapterContract } from "@udp/adapter-core/contract";
import type { AdapterFixture } from "@udp/adapter-core";
import { domainContractEnv } from "@udp/adapter-core/testing";
import { describe, it } from "vitest";
import {
  HELM_IGNORED_PREFIXES,
  helmDriftMutations,
} from "../../adapter-base/contract-fixtures.js";
import adapter from "./index.js";

/** Loki + Grafana qua đủ bộ hợp đồng (Plan #32 AC-1): ba release, tiêu thụ maxStorageGb */

function fixture(): AdapterFixture {
  return {
    validConfig: { retentionHours: 168, storageGb: 20 },
    invalidConfigs: [
      { retentionHours: 1 },
      { storageGb: 0 },
      { retentionHours: "một tuần" },
    ],
    externalHosts: [],
    quotaDimensions: ["maxStorageGb"],
    ignoredLabelPrefixes: HELM_IGNORED_PREFIXES,
    driftMutations: helmDriftMutations("udp-loki", {
      companions: ["udp-loki-promtail", "udp-loki-grafana"],
    }),
  };
}

describe("loki", () => {
  runDomainAdapterContract(adapter, () => domainContractEnv(fixture()), {
    describe,
    it,
  });
});
