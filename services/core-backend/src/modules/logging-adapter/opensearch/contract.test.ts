import { runDomainAdapterContract } from "@udp/adapter-core/contract";
import type { AdapterFixture } from "@udp/adapter-core";
import { domainContractEnv } from "@udp/adapter-core/testing";
import { describe, it } from "vitest";
import {
  HELM_IGNORED_PREFIXES,
  helmDriftMutations,
} from "../../adapter-base/contract-fixtures.js";
import adapter from "./index.js";

/** OpenSearch qua đủ bộ hợp đồng (Plan #32 AC-1): mật khẩu admin là bí mật, khoá phẳng trong Secret */

function fixture(): AdapterFixture {
  return {
    validConfig: {
      adminPassword: "Canh-P32-opensearch1",
      replicas: 1,
      storageGb: 30,
    },
    invalidConfigs: [
      { adminPassword: "yeu" },
      { adminPassword: "khongcohoavaso!" },
      { adminPassword: "Canh-P32-opensearch1", replicas: 9 },
    ],
    externalHosts: [],
    quotaDimensions: ["maxStorageGb"],
    ignoredLabelPrefixes: HELM_IGNORED_PREFIXES,
    driftMutations: helmDriftMutations("udp-opensearch", {
      secrets: true,
      companions: ["udp-opensearch-dashboards", "udp-opensearch-fluent-bit"],
    }),
  };
}

describe("opensearch", () => {
  runDomainAdapterContract(adapter, () => domainContractEnv(fixture()), {
    describe,
    it,
  });
});
