import { resolve } from "node:path";
import { domainContractEnv } from "@udp/adapter-core/testing";
import type { DomainAdapter } from "@udp/adapter-core";
import { describe, expect, it } from "vitest";
import { dockerConfigOf } from "../src/modules/adapter-base/registry-pull.js";
import { validateAndOrder } from "../src/modules/capability/capability.resolver.js";
import { createRegistry } from "../src/modules/domain/domain-adapter.registry.js";
import artifactory from "../src/modules/artifact-registry-adapter/artifactory/index.js";
import githubPackages from "../src/modules/artifact-registry-adapter/github-packages/index.js";
import nexus from "../src/modules/artifact-registry-adapter/nexus/index.js";
import ecr from "../src/modules/container-registry-adapter/ecr/index.js";
import harbor from "../src/modules/container-registry-adapter/harbor/index.js";
import prometheusGrafana from "../src/modules/monitoring-adapter/prometheus-grafana/index.js";

/**
 * Plan #35 AC-3, AC-4 trên registry THẬT của sản phẩm: registry của cloud kéo bằng định danh
 * node (không khoá), registry cần khoá khai `pullCredential`; `packages.store` và `registry.oci`
 * ở validator.
 */

const product = createRegistry({
  root: resolve(import.meta.dirname, "../src/modules"),
});

const GH_TOKEN = `ghp_${"a".repeat(36)}`;

describe("khoá kéo theo từng registry (AC-3)", () => {
  it("registry của cloud không khai pullCredential; registry cần khoá thì khai", async () => {
    const loaded = (await product).all();
    const withPull = loaded
      .filter((l) => l.pullCredential !== undefined)
      .map((l) => l.key)
      .sort();
    expect(withPull).toEqual([
      "artifact_registry:artifactory",
      "artifact_registry:github-packages",
      "artifact_registry:nexus",
      "container_registry:acr",
      "container_registry:docker-hub",
      "container_registry:ghcr",
      "container_registry:harbor",
    ]);
    const cloud = loaded.filter((l) =>
      [
        "container_registry:ecr",
        "container_registry:gcp-artifact-registry",
      ].includes(l.key),
    );
    expect(cloud.map((l) => l.pullCredential)).toEqual([undefined, undefined]);
  });

  it("khoá rỗng khi cấu hình không có; có ⇒ đúng server của registry", async () => {
    const registry = await product;
    const pull = (tool: string, config: Record<string, unknown>) =>
      registry
        .all()
        .find((l) => l.key === tool)
        ?.pullCredential?.(config);
    expect(pull("container_registry:ghcr", { owner: "acme" })).toBeNull();
    expect(
      pull("container_registry:ghcr", { owner: "Acme", token: GH_TOKEN }),
    ).toEqual({ server: "ghcr.io", username: "Acme", password: GH_TOKEN });
    expect(
      pull("container_registry:docker-hub", {
        namespace: "acme",
        username: "acmebot",
        accessToken: "dckr_pat_canhTokenDockerP35abc",
      })?.server,
    ).toBe("https://index.docker.io/v1/");
  });

  it("registry dịch vụ không ghi Secret nào; mô tả không mang khoá", async () => {
    const config = { owner: "acme", token: GH_TOKEN };
    const env = domainContractEnv({
      validConfig: config,
      invalidConfigs: [],
      externalHosts: [],
      quotaDimensions: [],
      ignoredLabelPrefixes: [],
      driftMutations: [],
    });
    expect((await githubPackages.deploy(env.context(), config)).status).toBe(
      "SUCCESS",
    );
    expect(env.cluster.writes.map((w) => w.ref.kind)).toEqual(["ConfigMap"]);
    const client = await env.cluster.getClient("tooling");
    const described = await client.read("get", env.cluster.writes[0]!.ref);
    expect(JSON.stringify(described)).not.toContain(GH_TOKEN);
  });

  it(".dockerconfigjson gộp nhiều registry theo thứ tự server, rỗng là {auths:{}}", () => {
    expect(dockerConfigOf([])).toBe('{"auths":{}}');
    const merged = JSON.parse(
      dockerConfigOf([
        { server: "z.io", username: "a", password: "p1" },
        { server: "ghcr.io", username: "b", password: "p2" },
      ]),
    ) as { auths: Record<string, { auth: string }> };
    expect(Object.keys(merged.auths)).toEqual(["ghcr.io", "z.io"]);
    expect(merged.auths["ghcr.io"]?.auth).toBe(
      Buffer.from("b:p2").toString("base64"),
    );
  });
});

describe("packages.store và registry.oci ở validator (AC-4)", () => {
  const consumer = (id: "packages.store" | "registry.oci"): DomainAdapter =>
    ({
      domainType: "CICD",
      toolId: `can-${id}`,
      capabilities: { provides: [], requires: [{ id }] },
    }) as never;

  it("Artifactory, Nexus, GitHub Packages thoả cả hai capability", () => {
    for (const provider of [artifactory, nexus, githubPackages]) {
      expect(
        validateAndOrder([provider, consumer("packages.store")]).valid,
        provider.toolId,
      ).toBe(true);
      expect(
        validateAndOrder([provider, consumer("registry.oci")]).valid,
        provider.toolId,
      ).toBe(true);
    }
  });

  it("registry.oci mà prometheus-grafana đòi: Harbor thoả; hai registry không chọn ⇒ AMBIGUOUS_PROVIDER", () => {
    expect(validateAndOrder([harbor, prometheusGrafana]).valid).toBe(true);
    expect(
      validateAndOrder([ecr, artifactory, prometheusGrafana]).errors[0],
    ).toMatchObject({ code: "AMBIGUOUS_PROVIDER" });
  });
});
