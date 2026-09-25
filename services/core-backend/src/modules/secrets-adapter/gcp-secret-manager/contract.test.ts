import { runDomainAdapterContract } from "@udp/adapter-core/contract";
import type { AdapterFixture } from "@udp/adapter-core";
import { domainContractEnv } from "@udp/adapter-core/testing";
import { describe, it } from "vitest";
import {
  HELM_IGNORED_PREFIXES,
  helmDriftMutations,
} from "../../adapter-base/contract-fixtures.js";
import adapter from "./index.js";

/** GCP Secret Manager qua đủ bộ hợp đồng (Plan #34 AC-1): CSI driver + provider GCP, Workload Identity */

function fixture(): AdapterFixture {
  return {
    validConfig: {
      projectId: "acme-prod-01",
      gcpServiceAccount: "udp-secrets@acme-prod-01.iam.gserviceaccount.com",
    },
    invalidConfigs: [
      { projectId: "A", gcpServiceAccount: "x@y.iam.gserviceaccount.com" },
      { projectId: "acme-prod-01", gcpServiceAccount: "khong-phai-email" },
    ],
    externalHosts: [],
    quotaDimensions: [],
    ignoredLabelPrefixes: HELM_IGNORED_PREFIXES,
    driftMutations: helmDriftMutations("udp-csi-secrets-store", {
      companions: ["udp-csi-provider-gcp"],
    }),
  };
}

describe("gcp-secret-manager", () => {
  runDomainAdapterContract(adapter, () => domainContractEnv(fixture()), {
    describe,
    it,
  });
});
