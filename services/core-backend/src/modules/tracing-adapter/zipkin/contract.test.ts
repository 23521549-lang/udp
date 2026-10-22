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
 * Zipkin qua đủ bộ hợp đồng (Plan #31 AC-3). Lưu trong bộ nhớ ⇒ `quotaDimensions` RỖNG, nên bộ
 * hợp đồng đòi nó chạy được với quota toàn 0 — nhánh đảo của Jaeger và Tempo.
 */

function fixture(): AdapterFixture {
  return {
    validConfig: { maxSpans: 500_000 },
    invalidConfigs: [
      { maxSpans: 10 },
      { maxSpans: 1e9 },
      { maxSpans: "nhiều" },
    ],
    externalHosts: [],
    quotaDimensions: [],
    ignoredLabelPrefixes: HELM_IGNORED_PREFIXES,
    driftMutations: helmDriftMutations("udp-zipkin"),
  };
}

describe("zipkin", () => {
  runDomainAdapterContract(adapter, () => domainContractEnv(fixture()), {
    describe,
    it,
  });
});
