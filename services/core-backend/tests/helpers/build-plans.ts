import { spawnSync } from "node:child_process";
import type { BuildPlan } from "@udp/adapter-core";
import { TEST_IMAGES } from "@udp/config";
import type {
  DockerHostCi,
  InClusterCi,
} from "../../src/modules/adapter-base/packaging/build-script.js";

/** [Plan #61] Kế hoạch build mẫu cho test của đoạn shell build và rebase: mọi kiểu đăng nhập, ghim chiến lược */
export const BASE: BuildPlan = {
  strategy: "auto",
  context: ".",
  dockerfile: "Dockerfile",
  platform: "linux/amd64",
  push: { kind: "basic", server: "registry.acme.vn" },
  identity: null,
  test: {
    kind: "run",
    command: "npm ci && npm test",
    image: TEST_IMAGES.nodejs,
  },
  signing: null,
};

export const PLANS: Record<string, BuildPlan> = {
  basic: BASE,
  ghcr: { ...BASE, push: { kind: "github-token", server: "ghcr.io" } },
  ecr: {
    ...BASE,
    push: {
      kind: "aws-ecr",
      server: "123456789012.dkr.ecr.eu-west-1.amazonaws.com",
      region: "eu-west-1",
    },
    identity: { cloud: "aws", roleArn: "arn:aws:iam::123456789012:role/udp/b" },
  },
  gcp: {
    ...BASE,
    push: { kind: "gcp", server: "europe-docker.pkg.dev" },
    identity: {
      cloud: "gcp",
      workloadIdentityProvider:
        "projects/42/locations/global/workloadIdentityPools/udp-build/providers/gitlab",
      serviceAccount: "udp-build-web@acme-prod.iam.gserviceaccount.com",
    },
  },
  acr: {
    ...BASE,
    push: {
      kind: "azure-acr",
      server: "acmeprod.azurecr.io",
      registryName: "acmeprod",
    },
    identity: {
      cloud: "azure",
      clientId: "11111111-2222-3333-4444-555555555555",
      tenantId: "66666666-7777-8888-9999-000000000000",
    },
  },
  ecrMissing: {
    ...BASE,
    push: {
      kind: "aws-ecr",
      server: "123456789012.dkr.ecr.eu-west-1.amazonaws.com",
      region: "eu-west-1",
    },
  },
  pinnedDockerfile: {
    ...BASE,
    strategy: "dockerfile",
    context: "services/web",
    dockerfile: "docker/Dockerfile.prod",
  },
  pinnedBuildpacks: { ...BASE, strategy: "buildpacks" },
};

/** `bash -n` trên kịch bản — chuỗi rỗng khi đúng cú pháp, không thì lỗi của bash */
export function bashCheck(script: string): string {
  const result = spawnSync("bash", ["-n"], { input: script, encoding: "utf8" });
  return result.status === 0 ? "" : result.stderr;
}

export const HOSTS: DockerHostCi[] = [
  "github-actions",
  "gitlab-ci",
  "circleci",
];
export const CLUSTER: InClusterCi[] = ["jenkins", "tekton", "drone"];

/** [Plan #61 QĐ-14] Khoá ký KMS mẫu của ba cloud và kế hoạch có ký tương ứng (danh tính ở cloud của khoá) */
export const SIGNING_KEYS = {
  aws: "awskms:///arn:aws:kms:eu-west-1:123456789012:key/0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0",
  gcp: "gcpkms://projects/acme-prod/locations/europe-west1/keyRings/udp/cryptoKeys/udp-sign-web/versions/1",
  azure: "azurekms://udp-web-a1b2c3.vault.azure.net/udp-sign",
} as const;

export const SIGNED: Record<"aws" | "gcp" | "azure", BuildPlan> = {
  aws: {
    ...PLANS.ecr!,
    signing: {
      key: SIGNING_KEYS.aws,
      identity: PLANS.ecr!.identity!,
      compat: true,
    },
  },
  gcp: {
    ...PLANS.gcp!,
    signing: {
      key: SIGNING_KEYS.gcp,
      identity: PLANS.gcp!.identity!,
      compat: true,
    },
  },
  // Registry không thuộc cloud (đẩy bằng mật khẩu) mà vẫn ký bằng KMS ở cloud của project
  azure: {
    ...BASE,
    signing: {
      key: SIGNING_KEYS.azure,
      identity: PLANS.acr!.identity!,
      compat: false,
    },
  },
};
