import { runDomainAdapterContract } from "@udp/adapter-core/contract";
import type { AdapterFixture } from "@udp/adapter-core";
import { domainContractEnv } from "@udp/adapter-core/testing";
import { describe, it } from "vitest";
import {
  HELM_IGNORED_PREFIXES,
  helmDriftMutations,
} from "../../adapter-base/contract-fixtures.js";
import adapter from "./index.js";

/** AWS Secrets Manager qua đủ bộ hợp đồng (Plan #34 AC-1): CSI driver + provider AWS, IRSA */

function fixture(): AdapterFixture {
  return {
    validConfig: {
      region: "ap-southeast-1",
      roleArn: "arn:aws:iam::123456789012:role/udp-secrets",
      rotationPollSeconds: 120,
    },
    invalidConfigs: [
      { region: "vung-la", roleArn: "arn:aws:iam::123456789012:role/x" },
      { region: "ap-southeast-1", roleArn: "arn:aws:iam::12:role/x" },
    ],
    externalHosts: [],
    quotaDimensions: [],
    ignoredLabelPrefixes: HELM_IGNORED_PREFIXES,
    driftMutations: helmDriftMutations("udp-csi-secrets-store", {
      companions: ["udp-csi-provider-aws"],
    }),
  };
}

describe("aws-secrets-manager", () => {
  runDomainAdapterContract(adapter, () => domainContractEnv(fixture()), {
    describe,
    it,
  });
});
