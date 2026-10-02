import { spawnSync } from "node:child_process";
import type { RegistryPush } from "@udp/adapter-core";
import { describe, expect, it } from "vitest";
import {
  identityScript,
  type CiIdentityConfig,
  type ClusterRef,
  type IdentityScriptInput,
} from "../src/modules/packaging/identity-script.js";

/**
 * [Plan #61 QĐ-6, QĐ-14] Script danh tính build: cú pháp bash đúng ở MỌI ô (cloud × CI × registry), chỉ tin đúng chủ
 * thể của project, chỉ được đẩy vào đúng repository, tạo khoá ký trong KMS của cloud của project (bất kể registry) và
 * chỉ cấp quyền ký trên đúng khoá đó, không tạo khoá dài hạn nào. Chạy thật trên ba cloud là sổ nợ `packaging-real`.
 */

type Cloud = "aws" | "gcp" | "azure";

const REGISTRIES: Record<Cloud, { push: RegistryPush; endpoint: string }> = {
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

/** Registry không thuộc cloud nào — project vẫn ký bằng KMS ở cloud của nó */
const GHCR = {
  push: { kind: "github-token", server: "ghcr.io" } as RegistryPush,
  endpoint: "ghcr.io/acme",
};

const REGIONS: Record<Cloud, string> = {
  aws: "ap-southeast-1",
  gcp: "asia-southeast1",
  azure: "southeastasia",
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

const CLUSTERS: Record<Cloud, ClusterRef> = {
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

const input = (
  cloud: Cloud,
  over: Partial<IdentityScriptInput> = {},
): IdentityScriptInput => ({
  slug: "web",
  cloud: { provider: cloud, region: REGIONS[cloud] },
  push: REGISTRIES[cloud].push,
  registryEndpoint: REGISTRIES[cloud].endpoint,
  ci: CIS.github as CiIdentityConfig,
  branches: ["main", "dev"],
  cluster: CLUSTERS[cloud],
  ...over,
});

const scriptOf = (i: IdentityScriptInput): string => {
  const result = identityScript(i);
  if (!result.ok) throw new Error(`không sinh được script: ${result.problem}`);
  return result.text;
};

const bashN = (text: string): string => {
  const r = spawnSync("bash", ["-n"], { input: text, encoding: "utf8" });
  return r.status === 0 ? "" : r.stderr;
};

/** Lệnh tạo khoá ký và cấp quyền ký ĐÚNG khoá, theo cloud */
const SIGNING: Record<Cloud, readonly string[]> = {
  aws: [
    "--key-spec ECC_NIST_P256 --key-usage SIGN_VERIFY",
    '"Action":["kms:Sign","kms:GetPublicKey","kms:DescribeKey"],"Resource":"$KEY_ARN"',
    '--arg key "awskms:///$KEY_ARN"',
  ],
  gcp: [
    "--purpose asymmetric-signing --default-algorithm ec-sign-p256-sha256",
    '--member "serviceAccount:$SA" --role roles/cloudkms.signerVerifier',
    "/cryptoKeys/$KEY/versions/1",
  ],
  azure: [
    "--kty EC --curve P-256 --ops sign verify",
    '--role "Key Vault Crypto User" --scope "$KEY_SCOPE"',
    "--enable-rbac-authorization true",
  ],
};

describe("script danh tính build và khoá ký", () => {
  for (const cloud of ["aws", "gcp", "azure"] as const) {
    for (const [ciName, ci] of Object.entries(CIS)) {
      for (const registry of ["cloud", "ghcr"] as const) {
        const name = `${cloud} · ${ciName} · registry ${registry}`;
        it(`${name}: bash -n, chủ thể đúng, khoá ký đúng cloud, không khoá dài hạn`, () => {
          const result = identityScript(
            input(cloud, {
              ci,
              ...(registry === "ghcr"
                ? { push: GHCR.push, registryEndpoint: GHCR.endpoint }
                : {}),
            }),
          );
          if (cloud === "azure" && ciName === "circleci") {
            // Chủ thể JWT của CircleCI mang id người chạy: Azure không federation được ⇒ ký trong cụm (Plan #61 QĐ-17)
            expect(result).toEqual({ ok: false, problem: "CIRCLECI_AZURE" });
            return;
          }
          expect(result.ok).toBe(true);
          if (!result.ok) return;
          expect(result.cloud).toBe(cloud);
          const text = result.text;
          expect(bashN(text)).toBe("");
          expect(text).toContain("set -euo pipefail");
          expect(text).toMatch(
            /printf "UDP_BUILD_IDENTITY=%s\\n" "\$\(jq -nc .*--rawfile pub \/tmp\/udp-sign\.pem/,
          );
          expect(text).toContain("signing:{key:$key,publicKey:$pub}");
          for (const needle of SIGNING[cloud]) expect(text).toContain(needle);
          // Không khoá dài hạn nào: không access key, không khoá service account, không secret của app
          expect(text).not.toMatch(
            /create-access-key|service-accounts keys create|credential reset|--create-cert/,
          );
          const subject =
            ciName === "github"
              ? "acme/web"
              : ciName === "gitlab"
                ? "acme/platform/web"
                : ciName === "circleci"
                  ? "66666666-7777-8888-9999-000000000000"
                  : "system:serviceaccount:udp-build:udp-builder";
          expect(text).toContain(subject);
          if (ciName === "github" || ciName === "gitlab") {
            expect(text).toContain("dev");
            expect(text).not.toContain("refs/heads/*");
          }
          // Quyền đẩy registry chỉ khi registry là của chính cloud này
          const pushGrant = {
            aws: "udp-build-push",
            gcp: "roles/artifactregistry.writer",
            azure: "--role AcrPush",
          }[cloud];
          if (registry === "cloud") expect(text).toContain(pushGrant);
          else expect(text).not.toContain(pushGrant);
        });
      }
    }
  }

  it("AWS: vai trò chỉ đẩy vào ĐÚNG repository <tiền tố>/<slug>; khoá ở region của project", () => {
    const text = scriptOf(
      input("aws", { cloud: { provider: "aws", region: "eu-west-1" } }),
    );
    expect(text).toContain("REPOSITORY=acme/web");
    expect(text).toContain(
      '"Resource":"arn:aws:ecr:$REGISTRY_REGION:$ACCOUNT:repository/$REPOSITORY"',
    );
    expect(text).toContain("REGION=eu-west-1");
    expect(text).toContain("REGISTRY_REGION=ap-southeast-1");
    expect(text).toContain("KEY_ALIAS=alias/udp-sign-web");
  });

  it("GCP: pool riêng của project; registry ngoài cloud ⇒ project lấy từ Cloud Shell, khoá ở region của project", () => {
    const own = scriptOf(input("gcp", { ci: CIS.jenkins as CiIdentityConfig }));
    expect(own).toContain("POOL=udp-web");
    expect(own).toContain("CLUSTER_PROJECT");
    expect(own).toContain("PROJECT=acme-prod");
    const other = scriptOf(
      input("gcp", { push: GHCR.push, registryEndpoint: GHCR.endpoint }),
    );
    expect(other).toContain(
      'PROJECT="${PROJECT:-$(gcloud config get-value project 2>/dev/null)}"',
    );
    expect(other).toContain("REGION=asia-southeast1");
  });

  it("Azure: Key Vault tên riêng theo subscription; người chạy nhận quyền data plane, phân quyền lan có thử lại giới hạn", () => {
    const text = scriptOf(input("azure"));
    expect(text).toContain(
      "VAULT=udp-web-$(az account show --query id --output tsv | sha256sum | cut -c1-6)",
    );
    expect(text).toContain('--role "Key Vault Crypto Officer"');
    expect(text).toContain("for _ in $(seq 1 30); do");
    expect(text).toContain(
      '--arg key "azurekms://$VAULT.vault.azure.net/udp-sign"',
    );
  });

  it("project chưa có cloud (region null): chỉ phần đẩy registry như trước Plan #61d, không khoá ký, dòng không có signing", () => {
    for (const cloud of ["aws", "gcp", "azure"] as const) {
      const text = scriptOf(
        input(cloud, { cloud: { provider: cloud, region: null } }),
      );
      expect(bashN(text)).toBe("");
      expect(text).not.toMatch(/kms|keyvault|udp-sign|signing:/);
      expect(text).toMatch(/printf "UDP_BUILD_IDENTITY=%s\\n" "\$\(jq -nc /);
      expect(text).toContain(
        {
          aws: "udp-build-push",
          gcp: "roles/artifactregistry.writer",
          azure: "--role AcrPush",
        }[cloud],
      );
    }
  });

  it("thiếu điều kiện ⇒ mã việc cần làm, không có script", () => {
    expect(
      identityScript(
        input("aws", {
          ci: { kind: "circleci", organizationId: null, projectId: null },
        }),
      ),
    ).toEqual({ ok: false, problem: "CIRCLECI_IDS" });
    expect(
      identityScript(
        input("aws", { ci: CIS.jenkins as CiIdentityConfig, cluster: null }),
      ),
    ).toEqual({ ok: false, problem: "NO_CLUSTER" });
    expect(
      identityScript(
        input("aws", {
          ci: CIS.jenkins as CiIdentityConfig,
          cluster: CLUSTERS.gcp,
        }),
      ),
    ).toEqual({ ok: false, problem: "CLUSTER_OTHER_CLOUD" });
    expect(
      identityScript(input("azure", { ci: CIS.circleci as CiIdentityConfig })),
    ).toEqual({ ok: false, problem: "CIRCLECI_AZURE" });
  });
});
