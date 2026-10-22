import { runDomainAdapterContract } from "@udp/adapter-core/contract";
import type { AdapterFixture } from "@udp/adapter-core";
import { domainContractEnv } from "@udp/adapter-core/testing";
import { describe, it } from "vitest";
import { tokenSigner, runCicdSuite } from "../../adapter-base/cicd-suite.js";
import {
  DESCRIPTOR_IGNORED_PREFIXES,
  descriptorDriftMutations,
} from "../../adapter-base/contract-fixtures.js";
import adapter from "./index.js";

/** gitlab-ci qua đủ bộ hợp đồng (Plan #36 AC-1) và bộ phép CI/CD dùng chung (chữ ký, thân, template) */

const REGISTRY = {
  id: "registry.oci",
  version: "1.0.0",
  providedBy: "container_registry:ghcr",
  endpoint: "ghcr.io/acme",
} as const;

function fixture(): AdapterFixture {
  return {
    validConfig: {
      projectPath: "acme/platform/web",
      gitlabUrl: "https://gitlab.com",
    },
    invalidConfigs: [
      { projectPath: "web" },
      { projectPath: "acme/web", gitlabUrl: "http://gitlab.acme.dev" },
    ],
    externalHosts: [],
    quotaDimensions: [],
    ignoredLabelPrefixes: DESCRIPTOR_IGNORED_PREFIXES,
    driftMutations: descriptorDriftMutations("udp-cicd-gitlab-ci"),
  };
}

describe("gitlab-ci", () => {
  runDomainAdapterContract(
    adapter,
    () =>
      domainContractEnv(fixture(), { resolved: { "registry.oci": REGISTRY } }),
    { describe, it },
  );
  runCicdSuite(adapter, tokenSigner("X-Gitlab-Token"), { describe, it });
});
