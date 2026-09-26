import { runDomainAdapterContract } from "@udp/adapter-core/contract";
import type { AdapterFixture } from "@udp/adapter-core";
import { domainContractEnv } from "@udp/adapter-core/testing";
import { describe, it } from "vitest";
import {
  HELM_IGNORED_PREFIXES,
  helmDriftMutations,
} from "../../adapter-base/contract-fixtures.js";
import adapter from "./index.js";

/** AWS ACK qua đủ bộ hợp đồng (Plan #37 AC-1) */

function fixture(): AdapterFixture {
  return {
    validConfig: { roleArn: "arn:aws:iam::123456789012:role/udp-ack" },
    invalidConfigs: [{ roleArn: "arn:aws:iam::123:role/udp-ack" }, {}],
    externalHosts: [],
    quotaDimensions: [],
    ignoredLabelPrefixes: HELM_IGNORED_PREFIXES,
    driftMutations: helmDriftMutations("udp-ack-s3", {
      companions: ["udp-ack-rds", "udp-ack-dynamodb"],
    }),
  };
}

describe("ack", () => {
  runDomainAdapterContract(adapter, () => domainContractEnv(fixture()), {
    describe,
    it,
  });
});
