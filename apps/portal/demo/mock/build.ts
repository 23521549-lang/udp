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
  DeploymentWire,
  RepoScanWire,
} from "@udp/shared-types/wire";
import { iso, OPENED_AT } from "./clock";
import type { ProjectRecord } from "./db";
import { fnv, hex, prng, uuidOf } from "./random";

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
    "python:3.12.15-slim@sha256:29113dcae7aad06daa8e95260fa09f27d62be33b9687ea3774f771d601a02256",
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

// ------------------------------------------------------------- [Plan #61 QĐ-14, QĐ-16] Ký image

/** Khoá CÔNG KHAI P-256 thật cho bản xem thử — khoá bí mật không tồn tại ở đâu; bản xem thử không có KMS */
const DEMO_KEYS = [
  "-----BEGIN PUBLIC KEY-----\nMFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE92As3/UzUlUytfW39VSLIABMe+N4\nWIlYslUbfoP6nNqQ1xMw/qNyyjMw1XV+qwrxwHPAqozvHYR57HIXLgULfg==\n-----END PUBLIC KEY-----\n",
  "-----BEGIN PUBLIC KEY-----\nMFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEqdzw6sbEWzVrQEjvRSRdi70PBHIP\nazmx7HJs8bBnvFiLzmb2crDEQi/zADbyhD6FgyrhCkTMZjfULHDWO+xYlA==\n-----END PUBLIC KEY-----\n",
  "-----BEGIN PUBLIC KEY-----\nMFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE5DGONR916H7dLLaq0uissbGEBUJv\njfEtvA4yR+8Hsol3nmcbTM/tNOk4CvKW+TGWZUpB3rIJTKQMUpXVVtJoHg==\n-----END PUBLIC KEY-----\n",
  "-----BEGIN PUBLIC KEY-----\nMFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAElcPjam8ER4GUdcEn5cJ5sHbL020c\nf4FZ8O9/wsyiY++hw/mA6fXTjs8B4P/NQYbIrVMOwt+gmvghj7MsOYjOyQ==\n-----END PUBLIC KEY-----\n",
] as const;

/** Dấu vân tay MINH HOẠ (Service 1 băm DER của khoá) — tất định theo khoá */
const keyIdOf = (publicKey: string): string => hex(prng(fnv(publicKey)), 16);

const CLOUD_OF_PROVIDER: Record<string, Cloud> = {
  AWS: "aws",
  GCP: "gcp",
  AZURE: "azure",
};

const projectCloudOf = (p: ProjectRecord): Cloud | null =>
  p.cloud === null ? null : (CLOUD_OF_PROVIDER[p.cloud.provider] ?? null);

/** Vì sao project chưa ký được — như `signingUnavailable` của Service 1 */
function signingBlockedOf(
  projectCloud: Cloud | null,
  ci: string | null,
): BuildViewWire["signing"]["reason"] {
  if (projectCloud === null) return "NO_CLOUD";
  if (ci === "circleci" && projectCloud === "azure") return "CIRCLECI_AZURE";
  return null;
}

/** URI khoá KMS minh hoạ ở region của project — đúng dạng cosign nhận */
function kmsOf(
  p: ProjectRecord,
  cloud: Cloud,
  slug: string,
  n: number,
): string {
  const region = p.cloud?.region ?? "ap-southeast-1";
  switch (cloud) {
    case "aws":
      return `awskms:///arn:aws:kms:${region}:482019473611:key/${uuidOf(`kms:${slug}:${String(n)}`)}`;
    case "gcp":
      return `gcpkms://projects/acme-prod/locations/${region}/keyRings/udp/cryptoKeys/udp-sign-${slug}/versions/${String(n + 1)}`;
    case "azure":
      return `azurekms://udp-${slug.slice(0, 12).replace(/-+$/, "")}-${hex(prng(fnv(slug)), 6)}.vault.azure.net/udp-sign`;
  }
}

/**
 * Cài đặt build sắp lưu, như `canonicalSigning` của Service 1: điền dấu vân tay và ngày thêm, bỏ khoá trùng; `enforce`
 * giữ giá trị đang lưu (bật/tắt là thao tác riêng) và tắt theo khi gỡ hết khoá
 */
export function storedSettings(
  before: BuildSettings | undefined,
  next: BuildSettings,
): BuildSettings {
  const seen = new Set<string>();
  const keys = next.signing.keys.flatMap((k) => {
    const id = keyIdOf(k.publicKey);
    if (seen.has(id)) return [];
    seen.add(id);
    return [
      {
        id,
        publicKey: k.publicKey,
        kms: k.kms,
        addedAt: k.addedAt ?? iso(Date.now()),
      },
    ];
  });
  const enforce = (before ?? DEFAULT_BUILD_SETTINGS).signing.enforce;
  return {
    ...next,
    signing: { ...next.signing, keys, enforce: enforce && keys.length > 0 },
  };
}

/** Nhãn DNS từ tên project (như `workloadSlugFor` của máy chủ, rút gọn cho bản xem thử) */
const slugOf = (name: string): string =>
  name
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40) || "app";

/**
 * Script minh hoạ theo cloud — bản thật do Service 1 sinh (`identity-script.ts`). `signing`: project ký được ⇒ script
 * tạo khoá trong KMS và dòng kết quả mang khoá CÔNG KHAI
 */
function demoScript(
  cloud: Cloud,
  slug: string,
  ci: string,
  signing: { kms: string; publicKey: string } | null,
): string {
  // [Plan #61 61d-2b-0] Hình bất biến của GitHub: script thật tin CẢ HAI hình, nhưng bản xem thử chỉ in một
  // chuỗi minh hoạ, nên in hình mới — hình mà mọi repo tạo sau 15/07/2026 phát ra
  const subject = IN_CLUSTER.has(ci)
    ? "system:serviceaccount:udp-build:udp-builder"
    : `repo:acme@1234/${slug}@5678:ref:refs/heads/main`;
  const lines: Record<Cloud, string[]> = {
    aws: [
      `ROLE=udp-build-${slug}`,
      `aws ecr create-repository --repository-name udp/${slug} >/dev/null 2>&1 || true`,
      `# vai trò chỉ tin chủ thể ${subject}, chỉ đẩy vào udp/${slug}`,
      'aws iam create-role --role-name "$ROLE" --path /udp/ --assume-role-policy-document file:///tmp/udp-trust.json >/dev/null',
      'aws iam put-role-policy --role-name "$ROLE" --policy-name udp-build-push --policy-document file:///tmp/udp-push.json',
    ],
    gcp: [
      `POOL=udp-${slug}`,
      'gcloud iam workload-identity-pools create "$POOL" --location global',
      `# provider chỉ nhận chủ thể ${subject}`,
      `gcloud iam service-accounts create udp-build-${slug}`,
    ],
    azure: [
      `NAME=udp-build-${slug}`,
      'az identity create --resource-group "$GROUP" --name "$NAME" >/dev/null',
      `# federated credential cho chủ thể ${subject}`,
      'az role assignment create --assignee-object-id "$PRINCIPAL_ID" --role AcrPush --scope "$ACR_ID" >/dev/null',
    ],
  };
  const identity: Record<Cloud, Record<string, string>> = {
    aws: {
      cloud: "aws",
      roleArn: `arn:aws:iam::482019473611:role/udp/udp-build-${slug}`,
    },
    gcp: {
      cloud: "gcp",
      workloadIdentityProvider: `projects/731948205514/locations/global/workloadIdentityPools/udp-${slug}/providers/cluster`,
      serviceAccount: `udp-build-${slug}@acme-prod.iam.gserviceaccount.com`,
    },
    azure: {
      cloud: "azure",
      clientId: "3f6b2d1e-8c4a-4e9f-b2d7-91a0c5e4f8b3",
      tenantId: "9b1c7e2a-4d5f-4a8b-8e3c-2f6d1a9b7c40",
    },
  };
  const result =
    signing === null
      ? identity[cloud]
      : {
          ...identity[cloud],
          signing: { key: signing.kms, publicKey: signing.publicKey },
        };
  return [
    "#!/usr/bin/env bash",
    `# UDP: danh tính build của ${slug} (bản xem thử: minh hoạ rút gọn). Chạy MỘT lần bằng quyền quản trị.`,
    "set -euo pipefail",
    ...lines[cloud],
    ...(signing === null
      ? []
      : [
          "# khoá ký ECDSA P-256 trong KMS của project; danh tính chỉ được ký bằng đúng khoá này",
        ]),
    `echo 'UDP_BUILD_IDENTITY=${JSON.stringify(result)}'`,
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
  const projectCloud = projectCloudOf(p);
  const blocked = signingBlockedOf(projectCloud, ci);
  // Danh tính cần cho việc đẩy (registry của cloud) hay cho việc ký (project có cloud và ký được)
  const cloud =
    (effective === null ? null : (CLOUD_OF[effective] ?? null)) ??
    (blocked === null ? projectCloud : null);

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
        const slug = slugOf(p.project.name);
        identityScript = {
          cloud,
          text: demoScript(
            cloud,
            slug,
            ci,
            blocked === null
              ? {
                  kms: kmsOf(p, cloud, slug, settings.signing.keys.length),
                  publicKey: DEMO_KEYS[3],
                }
              : null,
          ),
        };
      }
      if (settings.identity?.cloud !== cloud) {
        todo.push({ code: "BUILD_IDENTITY", cloud });
      } else if (blocked === null && settings.signing.keys.length === 0) {
        todo.push({ code: "SIGNING_KEY", cloud });
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
    signing: { available: blocked === null, reason: blocked },
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
  seedSigning(projects, ecr);
}

const DAY = 86_400_000;

/** Khoá ký của project mẫu: khoá thứ `n` của bộ minh hoạ, thêm `days` ngày trước */
function keyOf(
  p: ProjectRecord,
  cloud: Cloud,
  n: number,
  days: number,
): BuildSettings["signing"]["keys"][number] {
  const publicKey = DEMO_KEYS[n] ?? DEMO_KEYS[0];
  return {
    id: keyIdOf(publicKey),
    publicKey,
    kms: kmsOf(p, cloud, slugOf(p.project.name), n),
    addedAt: iso(OPENED_AT - days * DAY),
  };
}

/**
 * [Plan #61 QĐ-14, QĐ-16] Đủ trạng thái của mục Ký image: đã bắt buộc với hai khoá (xoay khoá: khoá cũ vẫn được chấp
 * nhận) và lịch sử có lần bị cổng từ chối; chờ chữ ký đầu tiên (registry ngoài cloud, ký bằng KMS của cloud); danh tính
 * cũ chưa có khoá. Chưa có cloud và CircleCI trên Azure tự có trong dữ liệu mẫu. Tất định, không tiêu số ngẫu nhiên.
 */
function seedSigning(
  projects: readonly ProjectRecord[],
  ecr: ProjectRecord | undefined,
): void {
  if (ecr !== undefined && ecr.build !== undefined) {
    ecr.build = {
      ...ecr.build,
      signing: {
        keys: [keyOf(ecr, "aws", 0, 12), keyOf(ecr, "aws", 1, 160)],
        compat: true,
        enforce: true,
      },
    };
    stampVerdicts(ecr, OPENED_AT - 11 * DAY);
  }
  const waiting = projects.find(
    (p) =>
      p !== ecr &&
      p.build === undefined &&
      enabledTool(p, "CICD") === "github-actions" &&
      enabledTool(p, "CONTAINER_REGISTRY") === "ghcr" &&
      projectCloudOf(p) !== null,
  );
  const waitingCloud = waiting === undefined ? null : projectCloudOf(waiting);
  if (waiting !== undefined && waitingCloud !== null) {
    waiting.build = {
      ...DEFAULT_BUILD_SETTINGS,
      identity: identityOf(waitingCloud, slugOf(waiting.project.name)),
      signing: {
        keys: [keyOf(waiting, waitingCloud, 2, 1)],
        compat: false,
        enforce: false,
      },
    };
  }
  const legacy = projects.find(
    (p) =>
      p.build === undefined &&
      enabledTool(p, "CONTAINER_REGISTRY") === "acr" &&
      enabledTool(p, "CICD") !== "circleci" &&
      projectCloudOf(p) === "azure",
  );
  if (legacy !== undefined) {
    legacy.build = {
      ...DEFAULT_BUILD_SETTINGS,
      identity: identityOf("azure", slugOf(legacy.project.name)),
    };
  }
}

function identityOf(cloud: Cloud, slug: string): BuildSettings["identity"] {
  switch (cloud) {
    case "aws":
      return {
        cloud,
        roleArn: `arn:aws:iam::482019473611:role/udp/udp-build-${slug}`,
      };
    case "gcp":
      return {
        cloud,
        workloadIdentityProvider: `projects/731948205514/locations/global/workloadIdentityPools/udp-${slug}/providers/github`,
        serviceAccount: `udp-build-${slug.slice(0, 18).replace(/-+$/, "")}@acme-prod.iam.gserviceaccount.com`,
      };
    case "azure":
      return {
        cloud,
        clientId: "3f6b2d1e-8c4a-4e9f-b2d7-91a0c5e4f8b3",
        tenantId: "9b1c7e2a-4d5f-4a8b-8e3c-2f6d1a9b7c40",
      };
  }
}

/**
 * Lịch sử deploy của project đã bắt buộc: mọi lần deploy qua webhook từ lúc bắt buộc đã qua cổng (kể cả lần hỏng vì
 * readiness — chữ ký vẫn đúng), cộng hai lần cổng từ chối: production nhận lại chữ ký của một bản cũ (STALE), dev nhận
 * image từ pipeline cũ chưa có bước ký (MISSING).
 */
function stampVerdicts(p: ProjectRecord, since: number): void {
  for (const env of p.environments) {
    const list = p.deployments[env.id] ?? [];
    for (const d of list) {
      if (d.triggeredBy === "WEBHOOK" && Date.parse(d.startedAt) >= since) {
        d.signature = "VERIFIED";
      }
    }
    const older = list.find((d) => Date.parse(d.startedAt) < since);
    const rejection: {
      code: Exclude<DeploymentWire["signature"], "VERIFIED" | null>;
      detail: string;
      at: number;
    } = env.isProduction
      ? {
          code: "SIGNATURE_STALE",
          detail: "cũ hơn bản đang chạy",
          at: OPENED_AT - 3 * DAY - 2 * 3_600_000,
        }
      : {
          code: "SIGNATURE_MISSING",
          detail: "pipeline không gửi chữ ký",
          at: OPENED_AT - 9 * DAY - 5 * 3_600_000,
        };
    if (older === undefined) continue;
    const id = uuidOf(`rejected:${p.project.id}:${env.id}`);
    const event = {
      id: uuidOf(`rejected-event:${p.project.id}:${env.id}`),
      eventType: "DEPLOY_FAILURE" as const,
      occurredAt: iso(rejection.at),
    };
    list.push({
      ...older,
      deploymentId: id,
      status: "DEPLOY_FAILURE",
      signature: rejection.code,
      rebase: false,
      rolloutSessionId: null,
      restoresDeploymentId: null,
      startedAt: event.occurredAt,
      lastEventAt: event.occurredAt,
      events: [event],
    });
    list.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
    p.deployments[env.id] = list;
    p.deploymentLogs[id] = [
      {
        ...event,
        triggeredBy: "WEBHOOK",
        workloadName: older.workloadName,
        imageTag: older.imageTag,
        commitSha: older.commitSha,
        pipelineId: `run-${String(fnv(id) % 10_000)}`,
        detail: {
          reason: `Cổng deploy từ chối image: ${rejection.code} (${rejection.detail})`,
          signature: { code: rejection.code, detail: rejection.detail },
        },
      },
    ];
  }
}
