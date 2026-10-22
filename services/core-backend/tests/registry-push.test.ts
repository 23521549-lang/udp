import {
  registryPushOf,
  type AdapterFixture,
  type DomainAdapter,
} from "@udp/adapter-core";
import { domainContractEnv } from "@udp/adapter-core/testing";
import { describe, expect, it } from "vitest";
import artifactory from "../src/modules/artifact-registry-adapter/artifactory/index.js";
import githubPackages from "../src/modules/artifact-registry-adapter/github-packages/index.js";
import nexus from "../src/modules/artifact-registry-adapter/nexus/index.js";
import acr from "../src/modules/container-registry-adapter/acr/index.js";
import dockerHub from "../src/modules/container-registry-adapter/docker-hub/index.js";
import ecr from "../src/modules/container-registry-adapter/ecr/index.js";
import gcp from "../src/modules/container-registry-adapter/gcp-artifact-registry/index.js";
import ghcr from "../src/modules/container-registry-adapter/ghcr/index.js";
import harbor from "../src/modules/container-registry-adapter/harbor/index.js";

/**
 * [Plan #61 QĐ-6] Mọi registry cung cấp `registry.oci` khai cách ĐẨY trong thuộc tính binding — pipeline đăng nhập
 * theo đúng lời khai đó, không đoán theo tên tool.
 */

const CASES: [DomainAdapter, Record<string, unknown>, string, string][] = [
  [
    ecr,
    {
      accountId: "123456789012",
      region: "ap-southeast-1",
      repositoryPrefix: "acme/web",
    },
    "aws-ecr",
    "123456789012.dkr.ecr.ap-southeast-1.amazonaws.com/acme/web",
  ],
  [
    gcp,
    {
      projectId: "acme-prod-01",
      location: "asia-southeast1",
      repository: "web",
    },
    "gcp",
    "asia-southeast1-docker.pkg.dev/acme-prod-01/web",
  ],
  [
    acr,
    {
      registryName: "acmeprod",
      tokenName: "udp-pull",
      tokenPassword: "canhMatKhauAcrP35xyz",
    },
    "azure-acr",
    "acmeprod.azurecr.io",
  ],
  [
    dockerHub,
    {
      namespace: "acme",
      username: "acmebot",
      accessToken: "dckr_pat_canhTokenDockerP35abc",
    },
    "basic",
    "docker.io/acme",
  ],
  [
    ghcr,
    { owner: "Acme", username: "acme-bot", token: "ghp_" + "a".repeat(36) },
    "github-token",
    "ghcr.io/acme",
  ],
  [
    harbor,
    {
      externalUrl: "https://harbor.acme.dev",
      adminPassword: "Canh-Harbor-P35",
      storageGb: 50,
    },
    "basic",
    "harbor.acme.dev/library",
  ],
  [
    artifactory,
    {
      externalUrl: "https://artifacts.acme.dev",
      adminPassword: "canhArtifactoryP35",
      storageGb: 100,
    },
    "basic",
    "artifacts.acme.dev",
  ],
  [
    nexus,
    {
      externalUrl: "https://nexus.acme.dev",
      adminPassword: "canhNexusAdminP35",
      storageGb: 100,
      dockerPort: 8082,
    },
    "basic",
    "nexus.acme.dev:8082",
  ],
  [
    githubPackages,
    { owner: "acme", token: "ghp_" + "a".repeat(36) },
    "github-token",
    "ghcr.io/acme",
  ],
];

const fixture = (config: Record<string, unknown>): AdapterFixture => ({
  validConfig: config,
  invalidConfigs: [],
  externalHosts: [],
  quotaDimensions: ["maxStorageGb", "maxLoadBalancers"],
  ignoredLabelPrefixes: [],
  driftMutations: [],
});

describe("registry khai cách đẩy (Plan #61)", () => {
  for (const [adapter, config, kind, endpoint] of CASES) {
    it(`${adapter.toolId}: pushAuth = ${kind}, endpoint = ${endpoint}`, async () => {
      const env = domainContractEnv(fixture(config));
      const result = await adapter.deploy(env.context(), config);
      expect(result.status).toBe("SUCCESS");
      const binding = result.data?.find((b) => b.id === "registry.oci");
      expect(binding?.endpoint).toBe(endpoint);
      const push = registryPushOf(binding);
      expect(push?.kind).toBe(kind);
      expect(push?.server).toBe(endpoint.split("/")[0]);
    });
  }

  it("Harbor: đổi project thì image vào đúng project đó", async () => {
    const config = {
      externalUrl: "https://harbor.acme.dev",
      adminPassword: "Canh-Harbor-P35",
      project: "web-team",
    };
    const env = domainContractEnv(fixture(config));
    const result = await harbor.deploy(env.context(), config);
    expect(result.data?.find((b) => b.id === "registry.oci")?.endpoint).toBe(
      "harbor.acme.dev/web-team",
    );
  });
});
