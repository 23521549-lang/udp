import { spawnSync } from "node:child_process";
import type { RegistryPush } from "@udp/adapter-core";
import { describe, expect, it } from "vitest";
import {
  identityScript,
  type CiIdentityConfig,
  type ClusterRef,
} from "../src/modules/packaging/identity-script.js";

/**
 * [Plan #61 QĐ-6] Script danh tính build: cú pháp bash đúng ở MỌI ô (cloud × CI), chỉ tin đúng chủ thể của project, chỉ
 * được đẩy vào đúng repository, không tạo khoá nào. Chạy thật trên ba cloud là sổ nợ `cicd-webhook-real`.
 */

const REGISTRIES: Record<
  "aws" | "gcp" | "azure",
  { push: RegistryPush; endpoint: string }
> = {
  aws: {
    push: {
      kind: "aws-ecr",
      server: "123456789012.dkr.ecr.ap-southeast-1.amazonaws.com",
      region: "ap-southeast-1",
    },
    endpoint: "123456789012.dkr.ecr.ap-southeast-1.amazonaws.com/acme",
  },
  gcp: {
    push: { kind: "gcp", server: "asia-southeast1-docker.pkg.dev" },
    endpoint: "asia-southeast1-docker.pkg.dev/acme-prod/web",
  },
  azure: {
    push: {
      kind: "azure-acr",
      server: "acmeprod.azurecr.io",
      registryName: "acmeprod",
    },
    endpoint: "acmeprod.azurecr.io",
  },
};

const CIS: Record<string, CiIdentityConfig> = {
  github: { kind: "github-actions", repository: "acme/web" },
  gitlab: {
    kind: "gitlab-ci",
    projectPath: "acme/platform/web",
    gitlabUrl: "https://gitlab.com",
  },
  circleci: {
    kind: "circleci",
    organizationId: "11111111-2222-3333-4444-555555555555",
    projectId: "66666666-7777-8888-9999-000000000000",
  },
  jenkins: { kind: "in-cluster", tool: "jenkins" },
};

const CLUSTERS: Record<"aws" | "gcp" | "azure", ClusterRef> = {
  aws: {
    provider: "aws",
    providerId: "udp-web-a1b2",
    region: "ap-southeast-1",
  },
  gcp: {
    provider: "gcp",
    providerId: "udp-web-a1b2",
    region: "asia-southeast1",
  },
  azure: {
    provider: "azure",
    providerId:
      "/subscriptions/00000000-0000-0000-0000-000000000001/resourceGroups/udp-web/providers/Microsoft.ContainerService/managedClusters/udp-web-a1b2",
    region: "southeastasia",
  },
};

const bashN = (text: string): string => {
  const r = spawnSync("bash", ["-n"], { input: text, encoding: "utf8" });
  return r.status === 0 ? "" : r.stderr;
};

describe("script danh tính build", () => {
  for (const cloud of ["aws", "gcp", "azure"] as const) {
    for (const [ciName, ci] of Object.entries(CIS)) {
      it(`${cloud} · ${ciName}: bash -n, chủ thể đúng, đúng repository, không khoá`, () => {
        const result = identityScript({
          slug: "web",
          push: REGISTRIES[cloud].push,
          registryEndpoint: REGISTRIES[cloud].endpoint,
          ci,
          branches: ["main", "dev"],
          cluster: CLUSTERS[cloud],
        });
        if (cloud === "azure" && ciName === "circleci") {
          // CircleCI đẩy ACR bằng token: không có script
          expect(result).toEqual({ ok: false, problem: "NOT_CLOUD_REGISTRY" });
          return;
        }
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.cloud).toBe(cloud);
        expect(bashN(result.text)).toBe("");
        expect(result.text).toContain("set -euo pipefail");
        expect(result.text).toContain("UDP_BUILD_IDENTITY=");
        // Không tạo khoá dài hạn ở cloud nào
        expect(result.text).not.toMatch(
          /create-access-key|keys create|credential reset|--create-cert/,
        );
        const subject =
          ciName === "github"
            ? "acme/web"
            : ciName === "gitlab"
              ? "acme/platform/web"
              : ciName === "circleci"
                ? "66666666-7777-8888-9999-000000000000"
                : "system:serviceaccount:udp-build:udp-builder";
        expect(result.text).toContain(subject);
        if (ciName === "github" || ciName === "gitlab") {
          // Chỉ nhánh của các environment — không phải mọi nhánh
          expect(result.text).toContain("main");
          expect(result.text).toContain("dev");
          expect(result.text).not.toContain("refs/heads/*");
        }
      });
    }
  }

  it("AWS: vai trò chỉ đẩy vào ĐÚNG repository <tiền tố>/<slug>", () => {
    const result = identityScript({
      slug: "web",
      push: REGISTRIES.aws.push,
      registryEndpoint: REGISTRIES.aws.endpoint,
      ci: CIS.github as CiIdentityConfig,
      branches: ["main"],
      cluster: null,
    });
    if (!result.ok) throw new Error("không sinh được script");
    expect(result.text).toContain("REPOSITORY=acme/web");
    expect(result.text).toContain(
      '"Resource":"arn:aws:ecr:$REGION:$ACCOUNT:repository/$REPOSITORY"',
    );
  });

  it("GCP: pool riêng của project (chủ thể SA build trùng nhau giữa các cluster)", () => {
    const result = identityScript({
      slug: "web",
      push: REGISTRIES.gcp.push,
      registryEndpoint: REGISTRIES.gcp.endpoint,
      ci: CIS.jenkins as CiIdentityConfig,
      branches: ["main"],
      cluster: CLUSTERS.gcp,
    });
    if (!result.ok) throw new Error("không sinh được script");
    expect(result.text).toContain("POOL=udp-web");
    expect(result.text).toContain("CLUSTER_PROJECT");
  });

  it("thiếu điều kiện ⇒ mã việc cần làm, không có script", () => {
    expect(
      identityScript({
        slug: "web",
        push: REGISTRIES.aws.push,
        registryEndpoint: REGISTRIES.aws.endpoint,
        ci: { kind: "circleci", organizationId: null, projectId: null },
        branches: ["main"],
        cluster: null,
      }),
    ).toEqual({ ok: false, problem: "CIRCLECI_IDS" });
    expect(
      identityScript({
        slug: "web",
        push: REGISTRIES.aws.push,
        registryEndpoint: REGISTRIES.aws.endpoint,
        ci: CIS.jenkins as CiIdentityConfig,
        branches: ["main"],
        cluster: null,
      }),
    ).toEqual({ ok: false, problem: "NO_CLUSTER" });
    expect(
      identityScript({
        slug: "web",
        push: REGISTRIES.aws.push,
        registryEndpoint: REGISTRIES.aws.endpoint,
        ci: CIS.jenkins as CiIdentityConfig,
        branches: ["main"],
        cluster: CLUSTERS.gcp,
      }),
    ).toEqual({ ok: false, problem: "CLUSTER_OTHER_CLOUD" });
    expect(
      identityScript({
        slug: "web",
        push: { kind: "basic", server: "registry.acme.vn" },
        registryEndpoint: "registry.acme.vn/web",
        ci: CIS.github as CiIdentityConfig,
        branches: ["main"],
        cluster: null,
      }),
    ).toEqual({ ok: false, problem: "NOT_CLOUD_REGISTRY" });
  });
});
