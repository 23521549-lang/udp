import { runDomainAdapterContract } from "@udp/adapter-core/contract";
import type { AdapterFixture } from "@udp/adapter-core";
import { domainContractEnv } from "@udp/adapter-core/testing";
import { describe, it } from "vitest";
import {
  DESCRIPTOR_IGNORED_PREFIXES,
  descriptorDriftMutations,
} from "../../adapter-base/contract-fixtures.js";
import adapter from "./index.js";

/** Terraform qua đủ bộ hợp đồng (Plan #37 AC-1) */

const CI = {
  id: "pipeline.trigger",
  version: "1.0.0",
  providedBy: "cicd:github-actions",
  attributes: { provider: "github-actions" },
} as const;

function fixture(): AdapterFixture {
  return {
    validConfig: {
      backend: { kind: "s3", bucket: "acme-tfstate", region: "ap-southeast-1" },
    },
    invalidConfigs: [
      { backend: { kind: "s3", bucket: "Acme", region: "ap-southeast-1" } },
      {
        backend: {
          kind: "s3",
          bucket: "acme-tfstate",
          region: "ap-southeast-1",
        },
        workingDirectory: "../etc",
      },
    ],
    externalHosts: [],
    quotaDimensions: [],
    ignoredLabelPrefixes: DESCRIPTOR_IGNORED_PREFIXES,
    driftMutations: descriptorDriftMutations("udp-steps-terraform"),
  };
}

describe("terraform", () => {
  runDomainAdapterContract(
    adapter,
    () =>
      domainContractEnv(fixture(), { resolved: { "pipeline.trigger": CI } }),
    {
      describe,
      it,
    },
  );
});
