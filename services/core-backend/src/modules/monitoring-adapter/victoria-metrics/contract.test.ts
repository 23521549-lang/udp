import { runDomainAdapterContract } from "@udp/adapter-core/contract";
import type { AdapterFixture } from "@udp/adapter-core";
import { domainContractEnv } from "@udp/adapter-core/testing";
import { describe, it } from "vitest";
import {
  HELM_IGNORED_PREFIXES,
  helmDriftMutations,
} from "../../adapter-base/contract-fixtures.js";
import adapter from "./index.js";

/**
 * VictoriaMetrics qua đủ bộ hợp đồng (Plan #31 AC-3). Cùng hình với Prometheus: không gọi ra
 * ngoài (`externalHosts` rỗng ⇒ mọi egress là đỏ) và TIÊU THỤ `maxStorageGb` (quota 0 ⇒ từ
 * chối) — nhánh ngược với ba adapter có agent.
 */

function fixture(): AdapterFixture {
  return {
    validConfig: { retentionDays: 30, storageGb: 20, grafana: true },
    invalidConfigs: [
      { retentionDays: 0, storageGb: 20 },
      { retentionDays: 30, storageGb: 5000 },
      { storageGb: 20 },
      { retentionDays: "ba mươi" },
    ],
    externalHosts: [],
    quotaDimensions: ["maxStorageGb"],
    ignoredLabelPrefixes: HELM_IGNORED_PREFIXES,
    driftMutations: helmDriftMutations("udp-vm"),
  };
}

describe("victoria-metrics", () => {
  runDomainAdapterContract(adapter, () => domainContractEnv(fixture()), {
    describe,
    it,
  });
});
