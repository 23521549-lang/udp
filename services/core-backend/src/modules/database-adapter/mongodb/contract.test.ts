import { runDomainAdapterContract } from "@udp/adapter-core/contract";
import type { AdapterFixture } from "@udp/adapter-core";
import { domainContractEnv } from "@udp/adapter-core/testing";
import { describe, it } from "vitest";
import {
  HELM_IGNORED_PREFIXES,
  helmDriftMutations,
} from "../../adapter-base/contract-fixtures.js";
import adapter from "./index.js";

/** MongoDB Community Operator qua đủ bộ hợp đồng (Plan #38 AC-1) — hai environment của project hợp đồng */

function fixture(): AdapterFixture {
  return {
    validConfig: {
      storageGb: 10,
      credentialSeed: "canhHatGiongMatKhauP38abcdefghijklmnop",
    },
    invalidConfigs: [
      { credentialSeed: "ngan" },
      {
        credentialSeed: "canhHatGiongMatKhauP38abcdefghijklmnop",
        mongodbVersion: "4.4",
      },
    ],
    externalHosts: [],
    quotaDimensions: ["maxDatabases", "maxStorageGb"],
    ignoredLabelPrefixes: HELM_IGNORED_PREFIXES,
    driftMutations: helmDriftMutations("udp-mongodb-operator", {
      secrets: true,
      companions: ["udp-mongodb-dev", "udp-mongodb-prod"],
    }),
  };
}

describe("mongodb", () => {
  runDomainAdapterContract(adapter, () => domainContractEnv(fixture()), {
    describe,
    it,
  });
});
