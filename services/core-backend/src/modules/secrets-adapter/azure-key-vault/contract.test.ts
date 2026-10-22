import { runDomainAdapterContract } from "@udp/adapter-core/contract";
import type { AdapterFixture } from "@udp/adapter-core";
import { domainContractEnv } from "@udp/adapter-core/testing";
import { describe, it } from "vitest";
import {
  HELM_IGNORED_PREFIXES,
  helmDriftMutations,
} from "../../adapter-base/contract-fixtures.js";
import adapter from "./index.js";

/** Azure Key Vault qua đủ bộ hợp đồng (Plan #34 AC-1): provider Azure gồm CSI driver, Workload Identity */

function fixture(): AdapterFixture {
  return {
    validConfig: {
      keyVaultName: "acme-kv-prod",
      tenantId: "11111111-2222-3333-4444-555555555555",
      clientId: "66666666-7777-8888-9999-000000000000",
    },
    invalidConfigs: [
      { keyVaultName: "a", tenantId: "x", clientId: "y" },
      {
        keyVaultName: "acme-kv-prod",
        tenantId: "khong-phai-uuid",
        clientId: "66666666-7777-8888-9999-000000000000",
      },
    ],
    externalHosts: [],
    quotaDimensions: [],
    ignoredLabelPrefixes: HELM_IGNORED_PREFIXES,
    driftMutations: helmDriftMutations("udp-csi-provider-azure"),
  };
}

describe("azure-key-vault", () => {
  runDomainAdapterContract(adapter, () => domainContractEnv(fixture()), {
    describe,
    it,
  });
});
