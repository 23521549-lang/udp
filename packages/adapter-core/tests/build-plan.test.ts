import { describe, expect, it } from "vitest";
import {
  assertBuildPlanSafe,
  BuildPlanError,
  identityCloudOf,
  isSafeBuildPath,
  registryPushOf,
  registryServerOf,
  type BuildPlan,
} from "../src/index.js";

/** [Plan #61 QĐ-3] Kế hoạch build: thuần, và mọi chuỗi đi vào template đều qua luật ký tự */

const PLAN: BuildPlan = {
  strategy: "auto",
  context: ".",
  dockerfile: "Dockerfile",
  platform: "linux/amd64",
  push: {
    kind: "aws-ecr",
    server: "123456789012.dkr.ecr.ap-southeast-1.amazonaws.com",
    region: "ap-southeast-1",
  },
  identity: {
    cloud: "aws",
    roleArn: "arn:aws:iam::123456789012:role/udp/udp-build-web",
  },
  test: { kind: "run", command: "npm ci && npm test", image: "node:22" },
  signing: null,
};

const KMS_AWS =
  "awskms:///arn:aws:kms:ap-southeast-1:123456789012:key/0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0";

const rejects = (plan: BuildPlan): void => {
  expect(() => {
    assertBuildPlanSafe(plan);
  }).toThrow(BuildPlanError);
};

describe("registryPushOf", () => {
  it("đọc kiểu đẩy và tham số từ thuộc tính binding registry.oci", () => {
    expect(
      registryPushOf({
        endpoint: "123456789012.dkr.ecr.eu-west-1.amazonaws.com/udp",
        attributes: { pushAuth: "aws-ecr", region: "eu-west-1" },
      }),
    ).toEqual({
      kind: "aws-ecr",
      server: "123456789012.dkr.ecr.eu-west-1.amazonaws.com",
      region: "eu-west-1",
    });
    expect(
      registryPushOf({
        endpoint: "acme.azurecr.io",
        attributes: { pushAuth: "azure-acr", registryName: "acme" },
      }),
    ).toEqual({
      kind: "azure-acr",
      server: "acme.azurecr.io",
      registryName: "acme",
    });
    expect(
      registryPushOf({
        endpoint: "nexus.acme.vn:8443",
        attributes: { pushAuth: "basic" },
      }),
    ).toEqual({ kind: "basic", server: "nexus.acme.vn:8443" });
  });

  it("thiếu thuộc tính, thiếu tham số hay kiểu lạ ⇒ null (không đoán)", () => {
    expect(registryPushOf(undefined)).toBeNull();
    expect(registryPushOf({ endpoint: "ghcr.io/acme" })).toBeNull();
    expect(
      registryPushOf({
        endpoint: "x.dkr.ecr.eu-west-1.amazonaws.com/udp",
        attributes: { pushAuth: "aws-ecr" },
      }),
    ).toBeNull();
    expect(
      registryPushOf({
        endpoint: "ghcr.io/a",
        attributes: { pushAuth: "ftp" },
      }),
    ).toBeNull();
  });

  it("máy chủ là phần trước dấu / đầu tiên, giữ cổng", () => {
    expect(registryServerOf("ghcr.io/acme")).toBe("ghcr.io");
    expect(registryServerOf("nexus.acme.vn:8443/docker")).toBe(
      "nexus.acme.vn:8443",
    );
  });

  it("chỉ registry của cloud cần danh tính", () => {
    expect(identityCloudOf("aws-ecr")).toBe("aws");
    expect(identityCloudOf("gcp")).toBe("gcp");
    expect(identityCloudOf("azure-acr")).toBe("azure");
    expect(identityCloudOf("basic")).toBeNull();
    expect(identityCloudOf("github-token")).toBeNull();
  });
});

describe("assertBuildPlanSafe", () => {
  it("kế hoạch hợp lệ qua", () => {
    expect(() => {
      assertBuildPlanSafe(PLAN);
    }).not.toThrow();
    expect(() => {
      assertBuildPlanSafe({
        ...PLAN,
        context: "services/web",
        dockerfile: "docker/Dockerfile.prod",
        test: { kind: "skip" },
      });
    }).not.toThrow();
  });

  it("đường dẫn: không .., không tuyệt đối, không ký tự đặc biệt", () => {
    for (const bad of ["../x", "a/../b", "/etc", "a b", "a'b", "a%b", ""]) {
      expect(isSafeBuildPath(bad), bad).toBe(false);
      rejects({ ...PLAN, context: bad });
    }
    rejects({ ...PLAN, dockerfile: "." });
  });

  it("[Plan #61 QĐ-14] ký: URI khoá đúng dạng, cùng cloud với danh tính ký, danh tính đúng định dạng", () => {
    const signing = { key: KMS_AWS, identity: PLAN.identity!, compat: true };
    expect(() => {
      assertBuildPlanSafe({ ...PLAN, signing });
    }).not.toThrow();
    // Registry không thuộc cloud vẫn ký được: danh tính ký là của cloud của project
    expect(() => {
      assertBuildPlanSafe({
        ...PLAN,
        push: { kind: "basic", server: "ghcr.io" },
        identity: null,
        signing,
      });
    }).not.toThrow();
    rejects({ ...PLAN, signing: { ...signing, key: "awskms:///alias/x" } });
    rejects({
      ...PLAN,
      signing: {
        ...signing,
        key: "azurekms://udpvault.vault.azure.net/udp-sign",
      },
    });
    rejects({
      ...PLAN,
      signing: {
        ...signing,
        identity: { cloud: "aws", roleArn: "arn:aws:iam::1:user/x" },
      },
    });
  });

  it("danh tính phải khớp cloud của registry và đúng định dạng", () => {
    rejects({
      ...PLAN,
      identity: { cloud: "azure", clientId: "x", tenantId: "y" },
    });
    rejects({
      ...PLAN,
      identity: { cloud: "aws", roleArn: "arn:aws:iam::1:user/x" },
    });
  });

  it("lệnh test mang nháy, backslash, % hay xuống dòng bị từ chối", () => {
    for (const command of [
      'echo "x"',
      "echo 'x'",
      "a\\b",
      "50%",
      "a\nb",
      "`id`",
    ]) {
      rejects({ ...PLAN, test: { kind: "run", command, image: "node:22" } });
    }
  });

  it("máy chủ, region lạ bị từ chối", () => {
    rejects({ ...PLAN, push: { kind: "basic", server: "a b" } });
    rejects({
      ...PLAN,
      push: {
        kind: "aws-ecr",
        server: "123456789012.dkr.ecr.ap-southeast-1.amazonaws.com",
        region: "mars-1",
      },
    });
  });
});
