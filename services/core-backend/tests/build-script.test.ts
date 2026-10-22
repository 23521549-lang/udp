import { BUILD_TOOLCHAIN, TEST_IMAGES } from "@udp/config";
import { describe, expect, it } from "vitest";
import { buildNamespaceManifests } from "../src/modules/adapter-base/packaging/build-namespace.js";
import {
  BASE,
  bashCheck,
  CLUSTER,
  HOSTS,
  PLANS,
} from "./helpers/build-plans.js";
import {
  BUILD_NAMESPACE,
  BUILDER_SERVICE_ACCOUNT,
  dockerHostBuildLines,
  effectivePush,
  inClusterBuildContainers,
  needsOidc,
  oidcAudience,
  registrySecretNames,
  strategyLines,
  testStep,
  type DockerHostCi,
  type InClusterCi,
} from "../src/modules/adapter-base/packaging/build-script.js";

/**
 * [Plan #61 QĐ-4..QĐ-7] Đoạn shell mà sáu CI dùng để build. Kiểm bằng `bash -n` (cú pháp) trên MỌI ô — CI thật mới
 * chạy được lệnh, nhưng một dấu ngoặc lệch thì phải đỏ ở đây.
 */

describe("build-script: cú pháp shell (bash -n) ở mọi ô", () => {
  for (const [name, plan] of Object.entries(PLANS)) {
    for (const ci of HOSTS) {
      it(`máy có Docker · ${ci} · ${name}`, () => {
        const lines = dockerHostBuildLines(plan, ci, {
          image: "registry.acme.vn/web",
          commit: "$COMMIT",
          tmp: "/tmp/udp-build",
        });
        expect(bashCheck(lines.join("\n"))).toBe("");
      });
    }
    for (const ci of CLUSTER) {
      it(`trong cluster · ${ci} · ${name}`, () => {
        for (const c of inClusterBuildContainers(plan, ci, {
          image: "registry.acme.vn/web",
          commit: "$COMMIT",
        })) {
          expect(bashCheck(c.script.join("\n")), c.name).toBe("");
        }
      });
    }
  }
});

describe("build-script: luật", () => {
  it("không backslash, không %CHỮ_HOA% trong mọi kịch bản (an toàn cho Groovy và chỗ trống template)", () => {
    for (const plan of Object.values(PLANS)) {
      const texts = [
        ...HOSTS.map((ci) =>
          dockerHostBuildLines(plan, ci, {
            image: "r/x",
            commit: "$C",
            tmp: "/tmp/u",
          }).join("\n"),
        ),
        ...CLUSTER.flatMap((ci) =>
          inClusterBuildContainers(plan, ci, {
            image: "r/x",
            commit: "$C",
          }).map((c) => c.script.join("\n") + Object.values(c.env).join("")),
        ),
      ];
      for (const text of texts) {
        expect(text).not.toContain("\\");
        expect(text).not.toMatch(/%[A-Z_]+%/);
      }
    }
  });

  it("github-token chỉ ở GitHub Actions; CircleCI đẩy ACR bằng token", () => {
    const ghcr = PLANS.ghcr?.push;
    const acr = PLANS.acr?.push;
    if (ghcr === undefined || acr === undefined) throw new Error("thiếu ô");
    expect(effectivePush(ghcr, "github-actions").kind).toBe("github-token");
    expect(effectivePush(ghcr, "gitlab-ci").kind).toBe("basic");
    expect(effectivePush(acr, "circleci").kind).toBe("basic");
    expect(effectivePush(acr, "github-actions").kind).toBe("azure-acr");
    expect(registrySecretNames(ghcr, "jenkins")).toEqual([
      "UDP_REGISTRY_USERNAME",
      "UDP_REGISTRY_PASSWORD",
    ]);
    expect(registrySecretNames(ghcr, "github-actions")).toEqual([]);
    const acrPlan = PLANS.acr;
    if (acrPlan === undefined) throw new Error("thiếu ô");
    expect(needsOidc(acrPlan, "github-actions")).toBe(true);
    expect(needsOidc(acrPlan, "circleci")).toBe(false);
  });

  it("aud theo cloud", () => {
    expect(oidcAudience({ cloud: "aws", roleArn: "x" })).toBe(
      "sts.amazonaws.com",
    );
    expect(
      oidcAudience({
        cloud: "gcp",
        workloadIdentityProvider:
          "projects/1/locations/global/workloadIdentityPools/p/providers/q",
        serviceAccount: "s",
      }),
    ).toBe(
      "https://iam.googleapis.com/projects/1/locations/global/workloadIdentityPools/p/providers/q",
    );
    expect(oidcAudience({ cloud: "azure", clientId: "a", tenantId: "b" })).toBe(
      "api://AzureADTokenExchange",
    );
  });

  it("chiến lược: auto xét Dockerfile lúc chạy; ghim Dockerfile thiếu tệp thì dừng", () => {
    expect(strategyLines(BASE).join("\n")).toContain(
      'if [ -f "./Dockerfile" ]',
    );
    const pinned = PLANS.pinnedDockerfile;
    if (pinned === undefined) throw new Error("thiếu ô");
    const text = strategyLines(pinned).join("\n");
    expect(text).toContain("services/web/docker/Dockerfile.prod");
    expect(text).toContain("exit 1");
  });

  it("trong cluster: chuẩn bị (root) → token → đăng nhập → BuildKit (UID 1000, Unconfined) → Buildpacks → digest", () => {
    const ecr = PLANS.ecr;
    if (ecr === undefined) throw new Error("thiếu ô");
    const containers = inClusterBuildContainers(ecr, "tekton", {
      image: "r/x",
      commit: "$C",
    });
    expect(containers.map((c) => c.name)).toEqual([
      "udp-prepare",
      "udp-token",
      "udp-login",
      "udp-build-dockerfile",
      "udp-build-buildpacks",
      "udp-digest",
    ]);
    const [prepare, , login, buildkit, builder] = containers;
    expect(prepare?.runAsUser).toBe(0);
    expect(buildkit?.runAsUser).toBe(1000);
    expect(buildkit?.unconfined).toBe(true);
    expect(builder?.unconfined).toBe(false);
    expect(builder?.image).toBe(BUILD_TOOLCHAIN.images.builder);
    expect(login?.env.AWS_ROLE_ARN).toBe(
      "arn:aws:iam::123456789012:role/udp/b",
    );
    // Không container nào khác cần đặc quyền
    expect(containers.filter((c) => c.unconfined)).toHaveLength(1);
  });

  it("registry dùng mật khẩu trong cluster: không bước xin token, bí mật chỉ bằng TÊN", () => {
    const containers = inClusterBuildContainers(BASE, "drone", {
      image: "r/x",
      commit: "$C",
    });
    expect(containers.map((c) => c.name)).not.toContain("udp-token");
    const login = containers.find((c) => c.name === "udp-login");
    expect(login?.secretEnv).toEqual([
      "UDP_REGISTRY_USERNAME",
      "UDP_REGISTRY_PASSWORD",
    ]);
  });

  it("bước test: chạy, tắt tường minh, thiếu lệnh thì dừng", () => {
    expect(testStep(BASE).command).toBe("npm ci && npm test");
    expect(testStep({ ...BASE, test: { kind: "skip" } }).command).toContain(
      "bi tat",
    );
    const missing = testStep({
      ...BASE,
      test: { kind: "missing", language: "php" },
    });
    expect(missing.command).toContain("php");
    expect(missing.command).toContain("exit 1");
    expect(missing.image).toBe(BUILD_TOOLCHAIN.images.alpine);
  });
});

describe("namespace build", () => {
  it("Role của udp-builder chỉ cho xin token của CHÍNH nó; namespace chặn ingress", () => {
    const manifests = buildNamespaceManifests();
    const role = manifests.find((m) => m.kind === "Role") as {
      rules: {
        resources: string[];
        resourceNames: string[];
        verbs: string[];
      }[];
    };
    expect(role.rules).toEqual([
      {
        apiGroups: [""],
        resources: ["serviceaccounts/token"],
        resourceNames: [BUILDER_SERVICE_ACCOUNT],
        verbs: ["create"],
      },
    ]);
    expect(manifests.map((m) => m.kind)).toEqual([
      "Namespace",
      "ServiceAccount",
      "Role",
      "RoleBinding",
      "LimitRange",
      "NetworkPolicy",
    ]);
    for (const m of manifests.slice(1)) {
      expect((m.metadata as { namespace: string }).namespace).toBe(
        BUILD_NAMESPACE,
      );
    }
  });
});
