import { runDomainAdapterContract } from "@udp/adapter-core/contract";
import type { AdapterFixture } from "@udp/adapter-core";
import { domainContractEnv } from "@udp/adapter-core/testing";
import { describe, it } from "vitest";
import { hmacSigner, runCicdSuite } from "../../adapter-base/cicd-suite.js";
import {
  HELM_IGNORED_PREFIXES,
  helmDriftMutations,
} from "../../adapter-base/contract-fixtures.js";
import adapter from "./index.js";

/** tekton qua đủ bộ hợp đồng (Plan #36 AC-1) và bộ phép CI/CD dùng chung (chữ ký, thân, template) */

const REGISTRY = {
  id: "registry.oci",
  version: "1.0.0",
  providedBy: "container_registry:ghcr",
  endpoint: "ghcr.io/acme",
} as const;

function fixture(): AdapterFixture {
  return {
    validConfig: { replicas: 1 },
    invalidConfigs: [{ replicas: 0 }, { replicas: "một" }],
    externalHosts: [],
    quotaDimensions: [],
    ignoredLabelPrefixes: HELM_IGNORED_PREFIXES,
    driftMutations: helmDriftMutations("udp-tekton"),
  };
}

describe("tekton", () => {
  runDomainAdapterContract(
    adapter,
    () =>
      domainContractEnv(fixture(), { resolved: { "registry.oci": REGISTRY } }),
    { describe, it },
  );
  runCicdSuite(adapter, hmacSigner("X-UDP-Signature", "sha256="), {
    describe,
    it,
  });
});
