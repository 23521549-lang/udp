import { runDomainAdapterContract } from "@udp/adapter-core/contract";
import type { AdapterFixture } from "@udp/adapter-core";
import { domainContractEnv } from "@udp/adapter-core/testing";
import { describe, it } from "vitest";
import {
  HELM_IGNORED_PREFIXES,
  helmDriftMutations,
} from "../../adapter-base/contract-fixtures.js";
import adapter from "./index.js";

/** Falco qua đủ bộ hợp đồng (Plan #37 AC-1) */

function fixture(): AdapterFixture {
  return {
    validConfig: {},
    invalidConfigs: [{ driver: "gvisor" }, { minimumPriority: "fatal" }],
    externalHosts: [],
    quotaDimensions: [],
    ignoredLabelPrefixes: HELM_IGNORED_PREFIXES,
    driftMutations: helmDriftMutations("udp-falco"),
  };
}

describe("falco", () => {
  runDomainAdapterContract(adapter, () => domainContractEnv(fixture()), {
    describe,
    it,
  });
});
