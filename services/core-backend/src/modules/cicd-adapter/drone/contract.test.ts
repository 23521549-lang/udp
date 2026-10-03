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

/** drone qua đủ bộ hợp đồng (Plan #36 AC-1) và bộ phép CI/CD dùng chung (chữ ký, thân, template) */

const REGISTRY = {
  id: "registry.oci",
  version: "1.0.0",
  providedBy: "container_registry:ghcr",
  endpoint: "ghcr.io/acme",
} as const;

function fixture(): AdapterFixture {
  return {
    validConfig: {
      serverHost: "drone.acme.dev",
      gitProvider: "github",
      clientId: "Iv1.canhclient",
      clientSecret: "canhClientSecretP36xyz",
      rpcSecret: "canhRpcSecretP36abcdefghijklmnopqrstu",
      storageGb: 8,
    },
    invalidConfigs: [
      { serverHost: "https://drone.acme.dev", gitProvider: "github" },
      { serverHost: "drone.acme.dev", gitProvider: "bitbucket" },
    ],
    externalHosts: [],
    quotaDimensions: ["maxStorageGb"],
    ignoredLabelPrefixes: HELM_IGNORED_PREFIXES,
    driftMutations: helmDriftMutations("udp-drone", {
      secrets: true,
      companions: ["udp-drone-runner"],
    }),
  };
}

describe("drone", () => {
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
