import { runDomainAdapterContract } from "@udp/adapter-core/contract";
import type { AdapterFixture } from "@udp/adapter-core";
import { domainContractEnv } from "@udp/adapter-core/testing";
import { describe, it } from "vitest";
import {
  DESCRIPTOR_IGNORED_PREFIXES,
  descriptorDriftMutations,
} from "../../adapter-base/contract-fixtures.js";
import adapter from "./index.js";

/** Pulumi qua đủ bộ hợp đồng (Plan #37 AC-1) */

const CI = {
  id: "pipeline.trigger",
  version: "1.0.0",
  providedBy: "cicd:github-actions",
  attributes: { provider: "github-actions" },
} as const;

function fixture(): AdapterFixture {
  return {
    validConfig: { backend: { kind: "gcs", bucket: "acme-pulumi" } },
    invalidConfigs: [
      { backend: { kind: "gcs", bucket: "acme-pulumi" }, runtime: "java" },
      {},
    ],
    externalHosts: [],
    quotaDimensions: [],
    ignoredLabelPrefixes: DESCRIPTOR_IGNORED_PREFIXES,
    driftMutations: descriptorDriftMutations("udp-steps-pulumi"),
  };
}

describe("pulumi", () => {
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
