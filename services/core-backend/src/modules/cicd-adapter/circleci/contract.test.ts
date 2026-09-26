import { runDomainAdapterContract } from "@udp/adapter-core/contract";
import type { AdapterFixture } from "@udp/adapter-core";
import { domainContractEnv } from "@udp/adapter-core/testing";
import { describe, it } from "vitest";
import { hmacSigner, runCicdSuite } from "../../adapter-base/cicd-suite.js";
import {
  DESCRIPTOR_IGNORED_PREFIXES,
  descriptorDriftMutations,
} from "../../adapter-base/contract-fixtures.js";
import adapter from "./index.js";

/** circleci qua đủ bộ hợp đồng (Plan #36 AC-1) và bộ phép CI/CD dùng chung (chữ ký, thân, template) */

const REGISTRY = {
  id: "registry.oci",
  version: "1.0.0",
  providedBy: "container_registry:ghcr",
  endpoint: "ghcr.io/acme",
} as const;

function fixture(): AdapterFixture {
  return {
    validConfig: { projectSlug: "gh/acme/web" },
    invalidConfigs: [
      { projectSlug: "github/acme/web" },
      { projectSlug: "gh/acme" },
    ],
    externalHosts: [],
    quotaDimensions: [],
    ignoredLabelPrefixes: DESCRIPTOR_IGNORED_PREFIXES,
    driftMutations: descriptorDriftMutations("udp-cicd-circleci"),
  };
}

describe("circleci", () => {
  runDomainAdapterContract(
    adapter,
    () =>
      domainContractEnv(fixture(), { resolved: { "registry.oci": REGISTRY } }),
    { describe, it },
  );
  runCicdSuite(adapter, hmacSigner("circleci-signature", "v1="), {
    describe,
    it,
  });
});
