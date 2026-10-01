import {
  BUILDPACKS_LANGUAGES,
  DEFAULT_BUILD_SETTINGS,
  rebaseScheduleOf,
  type BuildLanguage,
  type BuildSettings,
} from "@udp/shared-types/build";
import type {
  BuildTodoWire,
  BuildViewWire,
  RepoScanWire,
} from "@udp/shared-types/wire";
import type { ProjectRecord } from "./db";

/**
 * [Plan #61] Mục Đóng gói của bản xem thử — cùng LUẬT với Service 1 (`modules/packaging`): cách đẩy theo registry,
 * quy đổi theo CI (GHCR ngoài GitHub Actions và ACR từ CircleCI đẩy bằng secret), dự đoán theo Golden Path hay lần
 * quét repo, việc cần làm. Script danh tính ở đây là bản MINH HOẠ rút gọn; bản thật do Service 1 sinh theo cloud và
 * CI của project.
 */

type Push = NonNullable<BuildViewWire["registry"]>["push"];
type Cloud = "aws" | "gcp" | "azure";

const TEST_IMAGE: Partial<Record<BuildLanguage, string>> = {
  nodejs:
    "node:22.23.3-alpine@sha256:0a7108bf6c7bf5de370ffb1a3ed6be93d405b43ff159f681a8d18c0e2bc2e402",
  python:
    "python:3.12.14-slim@sha256:f77ac9e44ae96ef2c90b8053ea08c31f8be030f824196b0ae4db6d462c84e51f",
  go: "golang:1.27.1@sha256:e0174e51e81218523251d85d248a90d24c3d5e81543b4f07a5d66229397db190",
  "java-maven":
    "maven:3.9.16-eclipse-temurin-25@sha256:93b8a14ea2f412782e4e842651273b4d903e35cc496284f178fbbe2d67d00976",
  "java-gradle":
    "gradle:9.8.0-jdk25@sha256:30f0c2e94f2b91cffaa192cebc86f1ba8efc574b9a8e93b33164e5f2ed839c08",
  dotnet:
    "mcr.microsoft.com/dotnet/sdk:10.0.401@sha256:35d40304542c8689331f8cab17c65926cdf48fe711e289321d71924b230a7d29",
};
const TEST_COMMAND: Partial<Record<BuildLanguage, string>> = {
  nodejs: "npm ci && npm test",
  python: "pip install -r requirements-dev.txt && pytest -q",
  go: "go test ./...",
  "java-maven": "mvn -B test",
  "java-gradle": "gradle test --no-daemon",
  dotnet: "dotnet test",
};

/**
 * Hồ sơ repo của project Import Existing — một bộ cố định theo vị trí của project: trang quét repo và mục Đóng gói đọc
 * CHUNG hồ sơ này nên không bao giờ nói hai điều khác nhau.
 */
interface RepoProfile {
  language: BuildLanguage;
  framework: string | null;
  dockerfile: string | null;
}
const PROFILES: readonly RepoProfile[] = [
  { language: "go", framework: null, dockerfile: null },
  {
    language: "java-maven",
    framework: "spring-boot",
    dockerfile: "Dockerfile",
  },
  { language: "dotnet", framework: null, dockerfile: null },
  { language: "rust", framework: null, dockerfile: null },
  { language: "ruby", framework: null, dockerfile: null },
  { language: "php", framework: null, dockerfile: "docker/Dockerfile" },
  { language: "static", framework: null, dockerfile: null },
  { language: "java-gradle", framework: null, dockerfile: null },
];

export function repoProfileOf(
  projects: readonly ProjectRecord[],
  p: ProjectRecord,
): RepoProfile | null {
  if (p.project.creationMode !== "IMPORT_EXISTING") return null;
  const imports = projects.filter(
    (x) => x.project.creationMode === "IMPORT_EXISTING",
  );
  return PROFILES[imports.indexOf(p) % PROFILES.length] ?? null;
}

/** Lần quét repo theo hồ sơ — mẫu golden đổi đúng các trường mà hồ sơ quyết định */
export function scanOf(base: RepoScanWire, profile: RepoProfile): RepoScanWire {
  const runtime = profile.language.startsWith("java")
    ? "java"
    : profile.language;
  return {
    ...base,
    runtime,
    language: profile.language,
    framework: profile.framework,
    findings: base.findings.map((f) => {
      if (f.id === "runtime") {
        return { ...f, status: "ok", detail: `Runtime ${runtime}` };
      }
      if (f.id !== "dockerfile") return f;
      if (profile.dockerfile !== null) {
        return {
          id: f.id,
          status: "ok",
          detail: "Có Dockerfile: UDP build image bằng Dockerfile (BuildKit)",
          evidence: [profile.dockerfile],
        };
      }
      return BUILDPACKS_LANGUAGES.includes(profile.language)
        ? {
            id: f.id,
            status: "ok",
            detail: `Không có Dockerfile: UDP build image bằng Buildpacks (${profile.language})`,
            evidence: [],
          }
        : {
            id: f.id,
            status: "missing",
            detail: `Chưa có Dockerfile và Buildpacks không build được ${profile.language}`,
            evidence: [],
            suggestion: {
              text: "Thêm Dockerfile ở gốc repo (hay khai đường Dockerfile trong mục Đóng gói)",
            },
          };
    }),
  };
}

const enabledTool = (p: ProjectRecord, domainType: string): string | null =>
  p.domains.domains.find((d) => d.domainType === domainType && d.isEnabled)
    ?.selectedTool ?? null;

const configText = (
  p: ProjectRecord,
  domainType: string,
  key: string,
): string | null => {
  const value = p.domains.domains.find((d) => d.domainType === domainType)
    ?.toolConfig?.[key];
  return typeof value === "string" ? value : null;
};

/** Máy chủ và cách đẩy theo registry đang bật — như thuộc tính `pushAuth` mà adapter thật khai */
function registryOf(
  p: ProjectRecord,
): { server: string; push: Push; registryName?: string } | null {
  const tool =
    enabledTool(p, "CONTAINER_REGISTRY") ?? enabledTool(p, "ARTIFACT_REGISTRY");
  const region = p.cluster?.region ?? "ap-southeast-1";
  switch (tool) {
    case "ecr":
      return {
        server: `${configText(p, "CONTAINER_REGISTRY", "accountId") ?? "482019473611"}.dkr.ecr.${region}.amazonaws.com`,
        push: "aws-ecr",
      };
    case "gcp-artifact-registry":
      return { server: "asia-southeast1-docker.pkg.dev", push: "gcp" };
    case "acr": {
      const name =
        configText(p, "CONTAINER_REGISTRY", "registryName") ?? "acmeplatform";
      return {
        server: `${name}.azurecr.io`,
        push: "azure-acr",
        registryName: name,
      };
    }
    case "ghcr":
    case "github-packages":
      return { server: "ghcr.io", push: "github-token" };
    case "docker-hub":
      return { server: "docker.io", push: "basic" };
    case "harbor":
      return { server: "harbor.acme-lab.vn", push: "basic" };
    case "artifactory":
      return { server: "artifacts.acme.vn", push: "basic" };
    case "nexus":
      return { server: "nexus.acme.vn:8082", push: "basic" };
    default:
      return null;
  }
}

const CLOUD_OF: Partial<Record<Push, Cloud>> = {
  "aws-ecr": "aws",
  gcp: "gcp",
  "azure-acr": "azure",
};

function effectivePush(push: Push, ci: string | null): Push {
  if (push === "github-token" && ci !== null && ci !== "github-actions") {
    return "basic";
  }
  if (push === "azure-acr" && ci === "circleci") return "basic";
  return push;
}

const IN_CLUSTER = new Set(["jenkins", "tekton", "drone"]);

/** Nhãn DNS từ tên project (như `workloadSlugFor` của máy chủ, rút gọn cho bản xem thử) */
const slugOf = (name: string): string =>
  name
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40) || "app";

/** Script minh hoạ theo cloud — bản thật do Service 1 sinh (`identity-script.ts`) */
function demoScript(cloud: Cloud, slug: string, ci: string): string {
  const subject = IN_CLUSTER.has(ci)
    ? "system:serviceaccount:udp-build:udp-builder"
    : `repo:acme/${slug}:ref:refs/heads/main`;
  const lines: Record<Cloud, string[]> = {
    aws: [
      `ROLE=udp-build-${slug}`,
      `aws ecr create-repository --repository-name udp/${slug} >/dev/null 2>&1 || true`,
      `# vai trò chỉ tin chủ thể ${subject}, chỉ đẩy vào udp/${slug}`,
      'aws iam create-role --role-name "$ROLE" --path /udp/ --assume-role-policy-document file:///tmp/udp-trust.json >/dev/null',
      'aws iam put-role-policy --role-name "$ROLE" --policy-name udp-build-push --policy-document file:///tmp/udp-push.json',
      `echo 'UDP_BUILD_IDENTITY={"cloud":"aws","roleArn":"arn:aws:iam::482019473611:role/udp/udp-build-${slug}"}'`,
    ],
    gcp: [
      `POOL=udp-${slug}`,
      'gcloud iam workload-identity-pools create "$POOL" --location global',
      `# provider chỉ nhận chủ thể ${subject}`,
      `gcloud iam service-accounts create udp-build-${slug}`,
      `echo 'UDP_BUILD_IDENTITY={"cloud":"gcp","workloadIdentityProvider":"projects/731948205514/locations/global/workloadIdentityPools/udp-${slug}/providers/cluster","serviceAccount":"udp-build-${slug}@acme-prod.iam.gserviceaccount.com"}'`,
    ],
    azure: [
      `NAME=udp-build-${slug}`,
      'az identity create --resource-group "$GROUP" --name "$NAME" >/dev/null',
      `# federated credential cho chủ thể ${subject}`,
      'az role assignment create --assignee-object-id "$PRINCIPAL_ID" --role AcrPush --scope "$ACR_ID" >/dev/null',
      `echo 'UDP_BUILD_IDENTITY={"cloud":"azure","clientId":"3f6b2d1e-8c4a-4e9f-b2d7-91a0c5e4f8b3","tenantId":"9b1c7e2a-4d5f-4a8b-8e3c-2f6d1a9b7c40"}'`,
    ],
  };
  return [
    "#!/usr/bin/env bash",
    `# UDP: danh tính build của ${slug} (bản xem thử: minh hoạ rút gọn). Chạy MỘT lần bằng quyền quản trị.`,
    "set -euo pipefail",
    ...lines[cloud],
    "",
  ].join("\n");
}

export function buildViewOf(
  projects: readonly ProjectRecord[],
  p: ProjectRecord,
): BuildViewWire {
  const settings: BuildSettings = p.build ?? DEFAULT_BUILD_SETTINGS;
  const profile = repoProfileOf(projects, p);
  const runtime = p.project.languageRuntime;
  const language: BuildViewWire["language"] =
    settings.language !== null
      ? { value: settings.language, source: "settings" }
      : profile !== null
        ? { value: profile.language, source: "scan" }
        : {
            value: runtime === "python" ? "python" : "nodejs",
            source: "runtime",
          };
  const ci = enabledTool(p, "CICD");
  const registry = registryOf(p);
  const effective = registry === null ? null : effectivePush(registry.push, ci);
  const cloud = effective === null ? null : (CLOUD_OF[effective] ?? null);

  const prediction: BuildViewWire["prediction"] =
    settings.strategy === "dockerfile"
      ? { strategy: "dockerfile", reason: "PINNED_DOCKERFILE" }
      : settings.strategy === "buildpacks"
        ? { strategy: "buildpacks", reason: "PINNED_BUILDPACKS" }
        : profile === null
          ? { strategy: "dockerfile", reason: "GOLDEN_PATH" }
          : profile.dockerfile !== null
            ? { strategy: "dockerfile", reason: "SCAN_DOCKERFILE" }
            : BUILDPACKS_LANGUAGES.includes(profile.language)
              ? { strategy: "buildpacks", reason: "SCAN_BUILDPACKS" }
              : { strategy: "unknown", reason: "SCAN_NEEDS_DOCKERFILE" };

  const command = TEST_COMMAND[language.value];
  const image = TEST_IMAGE[language.value];
  const test: BuildViewWire["test"] =
    settings.test.mode === "none"
      ? { kind: "skip" }
      : settings.test.mode === "custom"
        ? {
            kind: "run",
            command: settings.test.command,
            image: settings.test.image,
          }
        : command !== undefined && image !== undefined
          ? { kind: "run", command, image }
          : { kind: "missing", language: language.value };

  const todo: BuildTodoWire[] = [];
  if (ci === null) todo.push({ code: "ENABLE_CI" });
  if (registry === null) todo.push({ code: "ENABLE_REGISTRY" });
  let identityScript: BuildViewWire["identityScript"] = null;
  if (ci !== null && registry !== null && effective !== null) {
    if (effective === "basic") {
      todo.push({
        code: "CI_SECRETS",
        ci,
        names: ["UDP_REGISTRY_USERNAME", "UDP_REGISTRY_PASSWORD"],
      });
    }
    if (cloud !== null) {
      if (IN_CLUSTER.has(ci) && p.cluster === null) {
        todo.push({ code: "NO_CLUSTER" });
      } else {
        identityScript = {
          cloud,
          text: demoScript(cloud, slugOf(p.project.name), ci),
        };
      }
      if (settings.identity?.cloud !== cloud) {
        todo.push({ code: "BUILD_IDENTITY", cloud });
      }
    }
  }
  if (prediction.reason === "SCAN_NEEDS_DOCKERFILE") {
    todo.push({ code: "NEEDS_DOCKERFILE", language: language.value });
  }
  if (test.kind === "missing") {
    todo.push({ code: "TEST_COMMAND", language: language.value });
  }
  if (ci === "drone" && prediction.strategy !== "buildpacks") {
    todo.push({ code: "DRONE_TRUSTED" });
  }
  if (ci === "tekton") todo.push({ code: "TEKTON_RUN" });

  return {
    settings,
    platform: "linux/amd64",
    ci,
    registry:
      registry === null || effective === null
        ? null
        : {
            server: registry.server,
            push: registry.push,
            effectivePush: effective,
          },
    language,
    prediction,
    test,
    identity: {
      required: cloud !== null,
      configured: cloud !== null && settings.identity?.cloud === cloud,
      cloud,
    },
    identityScript,
    rebase: rebaseOf(settings, p, ci),
    todo,
  };
}

/** [Plan #61 QĐ-13] Cách đặt lịch rebase ở từng CI — giống Service 1 */
const REBASE_SCHEDULE: Record<
  string,
  NonNullable<BuildViewWire["rebase"]>["schedule"]
> = {
  "github-actions": "pipeline",
  jenkins: "pipeline",
  "gitlab-ci": "ci-settings",
  circleci: "ci-settings",
  drone: "ci-settings",
  tekton: "manual",
};

function rebaseOf(
  settings: BuildSettings,
  p: ProjectRecord,
  ci: string | null,
): BuildViewWire["rebase"] {
  const schedule = rebaseScheduleOf(settings, slugOf(p.project.name));
  const how = ci === null ? undefined : REBASE_SCHEDULE[ci];
  return schedule === null || how === undefined
    ? null
    : { ...schedule, schedule: how };
}

/**
 * Cài đặt build ban đầu của bản xem thử — đủ trạng thái để xem: danh tính đã có (registry của cloud, không còn việc gì),
 * lệnh test tự khai (Ruby), bước test tắt tường minh (web tĩnh), chiến lược ghim với thư mục build riêng (monorepo).
 */
export function seedBuildSettings(projects: readonly ProjectRecord[]): void {
  const first = (pred: (p: ProjectRecord) => boolean) => projects.find(pred);
  const withRegistry = (tool: string) =>
    first((p) => enabledTool(p, "CONTAINER_REGISTRY") === tool);
  const ecr = withRegistry("ecr");
  if (ecr !== undefined) {
    ecr.build = {
      ...DEFAULT_BUILD_SETTINGS,
      identity: {
        cloud: "aws",
        roleArn: `arn:aws:iam::482019473611:role/udp/udp-build-${slugOf(ecr.project.name)}`,
      },
    };
  }
  const gcp = withRegistry("gcp-artifact-registry");
  if (gcp !== undefined) {
    gcp.build = {
      ...DEFAULT_BUILD_SETTINGS,
      strategy: "buildpacks",
      context: "services/api",
    };
  }
  for (const p of projects) {
    const profile = repoProfileOf(projects, p);
    if (profile?.language === "ruby") {
      p.build = {
        ...DEFAULT_BUILD_SETTINGS,
        test: {
          mode: "custom",
          command: "bundle exec rspec",
          image: "ruby:3.4",
        },
      };
    }
    if (profile?.language === "static") {
      p.build = { ...DEFAULT_BUILD_SETTINGS, test: { mode: "none" } };
    }
  }
}
