import { runDomainAdapterContract } from "@udp/adapter-core/contract";
import type { AdapterFixture } from "@udp/adapter-core";
import { domainContractEnv } from "@udp/adapter-core/testing";
import { describe, it } from "vitest";
import {
  HELM_IGNORED_PREFIXES,
  helmDriftMutations,
} from "../../adapter-base/contract-fixtures.js";
import adapter from "./index.js";

/** Splunk (OTel Collector → HEC) qua đủ bộ hợp đồng (Plan #32 AC-1) */

function fixture(): AdapterFixture {
  return {
    validConfig: {
      hecEndpoint:
        "https://http-inputs-acme.splunkcloud.com/services/collector",
      hecToken: "0f8fad5b-d9cb-469f-a165-70867728950e",
      index: "main",
    },
    invalidConfigs: [
      {
        hecEndpoint: "http://splunk.vi-du.test/services/collector",
        hecToken: "0f8fad5b-d9cb-469f-a165-70867728950e",
      },
      {
        hecEndpoint:
          "https://http-inputs-acme.splunkcloud.com/services/collector",
        hecToken: "ngan",
      },
      { hecToken: "0f8fad5b-d9cb-469f-a165-70867728950e" },
    ],
    externalHosts: [],
    quotaDimensions: [],
    ignoredLabelPrefixes: HELM_IGNORED_PREFIXES,
    driftMutations: helmDriftMutations("udp-splunk", { secrets: true }),
  };
}

describe("splunk", () => {
  runDomainAdapterContract(adapter, () => domainContractEnv(fixture()), {
    describe,
    it,
  });
});
