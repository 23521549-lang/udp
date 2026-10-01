import {
  identityCloudOf,
  rebaseScheduleOf,
  registryPushOf,
} from "@udp/adapter-core";
import { BUILD_PLATFORM, workloadSlugFor } from "@udp/config";
import {
  BUILDPACKS_LANGUAGES,
  type BuildLanguage,
  type BuildSettings,
} from "@udp/shared-types";
import type { BuildTodoWire, BuildViewWire } from "@udp/shared-types/wire";
import type { Request } from "express";
import { prisma } from "../../core/db.js";
import {
  effectivePush,
  registrySecretNames,
  type CiTool,
} from "../adapter-base/packaging/build-script.js";
import { auditEntry } from "../audit/audit.service.js";
import { bindingsOfProject } from "../capability/capability-binding.repository.js";
import { buildTestOf, languageOf, settingsOf } from "./build-plan.js";
import {
  identityScript,
  type CiIdentityConfig,
  type ClusterRef,
} from "./identity-script.js";
import { scannedLanguageOf } from "./scanned-language.js";

/**
 * [Plan #61 QĐ-9] Mục "Đóng gói" của trang Mã nguồn: UDP sẽ build thế nào, vì sao, và người dùng còn phải làm gì
 * (secret của CI, danh tính build, lệnh test). Cùng các hàm mà pipeline dùng (`build-plan.ts`) — Portal không bao giờ
 * thấy một kế hoạch khác pipeline thật.
 */

const CI_TOOLS: readonly CiTool[] = [
  "github-actions",
  "gitlab-ci",
  "circleci",
  "jenkins",
  "tekton",
  "drone",
];

const isCiTool = (tool: string | null | undefined): tool is CiTool =>
  tool != null && (CI_TOOLS as readonly string[]).includes(tool);

const text = (config: unknown, key: string): string | null => {
  const value =
    typeof config === "object" && config !== null
      ? (config as Record<string, unknown>)[key]
      : undefined;
  return typeof value === "string" ? value : null;
};

/** Chủ thể của CI cho script danh tính — từ cấu hình (không bí mật) của adapter CI đang bật */
function ciIdentityOf(tool: CiTool, config: unknown): CiIdentityConfig {
  switch (tool) {
    case "github-actions":
      return { kind: tool, repository: text(config, "repository") ?? "" };
    case "gitlab-ci":
      return {
        kind: tool,
        projectPath: text(config, "projectPath") ?? "",
        gitlabUrl: text(config, "gitlabUrl") ?? "https://gitlab.com",
      };
    case "circleci":
      return {
        kind: tool,
        organizationId: text(config, "organizationId"),
        projectId: text(config, "projectId"),
      };
    default:
      return { kind: "in-cluster", tool };
  }
}

/** Đường Dockerfile như lần quét repo ghi (không có `./` đầu) */
const dockerfilePathOf = (settings: BuildSettings): string =>
  settings.context === "."
    ? settings.dockerfile
    : `${settings.context}/${settings.dockerfile}`;

function predictionOf(input: {
  settings: BuildSettings;
  goldenPath: boolean;
  repoScan: unknown;
  language: BuildLanguage;
}): BuildViewWire["prediction"] {
  const { settings } = input;
  if (settings.strategy === "dockerfile") {
    return { strategy: "dockerfile", reason: "PINNED_DOCKERFILE" };
  }
  if (settings.strategy === "buildpacks") {
    return { strategy: "buildpacks", reason: "PINNED_BUILDPACKS" };
  }
  if (input.goldenPath)
    return { strategy: "dockerfile", reason: "GOLDEN_PATH" };
  const findings =
    typeof input.repoScan === "object" && input.repoScan !== null
      ? (input.repoScan as { findings?: { id: string; evidence?: string[] }[] })
          .findings
      : undefined;
  if (findings === undefined) {
    return { strategy: "unknown", reason: "NOT_SCANNED" };
  }
  const dockerfiles =
    findings.find((f) => f.id === "dockerfile")?.evidence ?? [];
  if (dockerfiles.includes(dockerfilePathOf(settings))) {
    return { strategy: "dockerfile", reason: "SCAN_DOCKERFILE" };
  }
  return BUILDPACKS_LANGUAGES.includes(input.language)
    ? { strategy: "buildpacks", reason: "SCAN_BUILDPACKS" }
    : { strategy: "unknown", reason: "SCAN_NEEDS_DOCKERFILE" };
}

export async function buildView(projectId: string): Promise<BuildViewWire> {
  const [project, cicd, bindings, cluster] = await Promise.all([
    prisma.project.findUniqueOrThrow({
      where: { id: projectId },
      select: {
        name: true,
        creationMode: true,
        languageRuntime: true,
        buildSettings: true,
        repoScan: true,
        environments: {
          select: { name: true, isProduction: true },
          orderBy: { rank: "asc" },
        },
      },
    }),
    prisma.domainConfig.findFirst({
      where: { projectId, domainType: "CICD", isEnabled: true },
      select: { selectedTool: true, toolConfig: true },
    }),
    bindingsOfProject(prisma, projectId),
    // Cluster của project — issuer OIDC cho CI chạy trong cluster
    prisma.provisionedResource.findFirst({
      where: {
        projectId,
        kind: "cluster",
        status: "READY",
        providerId: { not: null },
      },
      select: { provider: true, providerId: true, region: true },
      orderBy: { createdAt: "desc" },
    }),
  ]);

  const settings = settingsOf(project.buildSettings);
  const language = languageOf({
    settings,
    scannedLanguage: scannedLanguageOf(project.repoScan),
    languageRuntime: project.languageRuntime,
  });
  const ci = isCiTool(cicd?.selectedTool) ? cicd.selectedTool : null;
  const binding = bindings.find((b) => b.capabilityId === "registry.oci");
  const push =
    binding?.endpoint == null
      ? null
      : registryPushOf({
          endpoint: binding.endpoint,
          attributes: binding.attributes ?? {},
        });
  // Chưa bật CI thì chưa có gì để quy đổi: cách đẩy là cách registry khai
  const effective =
    push === null ? null : ci === null ? push : effectivePush(push, ci);
  const identityCloud =
    effective === null ? null : identityCloudOf(effective.kind);
  const test = buildTestOf(settings, language.value);
  const prediction = predictionOf({
    settings,
    goldenPath: project.creationMode === "CREATE_NEW",
    repoScan: project.repoScan,
    language: language.value,
  });

  const schedule = rebaseScheduleOf(settings, workloadSlugFor(project.name));

  const todo: BuildTodoWire[] = [];
  if (ci === null) todo.push({ code: "ENABLE_CI" });
  if (binding === undefined) todo.push({ code: "ENABLE_REGISTRY" });
  else if (push === null) todo.push({ code: "REAPPLY_REGISTRY" });

  let script: BuildViewWire["identityScript"] = null;
  if (ci !== null && push !== null && effective !== null) {
    const names = registrySecretNames(push, ci);
    if (names.length > 0) todo.push({ code: "CI_SECRETS", ci, names });
    if (identityCloud !== null) {
      const result = identityScript({
        slug: workloadSlugFor(project.name),
        push,
        registryEndpoint: binding?.endpoint ?? "",
        ci: ciIdentityOf(ci, cicd?.toolConfig),
        branches: [
          "main",
          ...project.environments
            .filter((e) => !e.isProduction)
            .map((e) => e.name),
        ],
        cluster: clusterRefOf(cluster),
      });
      if (result.ok) script = { cloud: result.cloud, text: result.text };
      else if (result.problem !== "NOT_CLOUD_REGISTRY") {
        todo.push({ code: result.problem });
      }
      if (settings.identity?.cloud !== identityCloud) {
        todo.push({ code: "BUILD_IDENTITY", cloud: identityCloud });
      }
    }
  }
  if (
    prediction.reason === "SCAN_NEEDS_DOCKERFILE" ||
    (settings.strategy === "buildpacks" &&
      !BUILDPACKS_LANGUAGES.includes(language.value))
  ) {
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
    platform: BUILD_PLATFORM,
    ci,
    registry:
      push === null || effective === null
        ? null
        : {
            server: push.server,
            push: push.kind,
            effectivePush: effective.kind,
          },
    language,
    prediction,
    test:
      test.kind === "missing"
        ? { kind: "missing", language: language.value }
        : test,
    identity: {
      required: identityCloud !== null,
      configured:
        identityCloud !== null && settings.identity?.cloud === identityCloud,
      cloud: identityCloud,
    },
    identityScript: script,
    rebase:
      schedule === null || ci === null
        ? null
        : { ...schedule, schedule: REBASE_SCHEDULE[ci] },
    todo,
  };
}

/**
 * [Plan #61 QĐ-13] Lịch rebase ở từng CI: nằm sẵn trong tệp pipeline, phải tạo trong cài đặt của CI, hay tự lập (Tekton
 * chưa có Triggers — §16)
 */
const REBASE_SCHEDULE: Record<
  CiTool,
  NonNullable<BuildViewWire["rebase"]>["schedule"]
> = {
  "github-actions": "pipeline",
  jenkins: "pipeline",
  "gitlab-ci": "ci-settings",
  circleci: "ci-settings",
  drone: "ci-settings",
  tekton: "manual",
};

function clusterRefOf(
  row: { provider: string; providerId: string | null; region: string } | null,
): ClusterRef | null {
  if (row?.providerId == null) return null;
  const provider = row.provider.toLowerCase();
  return provider === "aws" || provider === "gcp" || provider === "azure"
    ? { provider, providerId: row.providerId, region: row.region }
    : null;
}

/** Đổi cài đặt build — MAINTAINER; nhật ký ghi trước/sau (cài đặt không mang khoá nào) */
export async function updateBuildSettings(
  projectId: string,
  settings: BuildSettings,
  request: Request,
): Promise<BuildViewWire> {
  const before = await prisma.project.findUniqueOrThrow({
    where: { id: projectId },
    select: { buildSettings: true },
  });
  await prisma.project.update({
    where: { id: projectId },
    data: {
      buildSettings: settings,
      auditLogs: {
        create: auditEntry({
          action: "project.build.update",
          targetType: "Project",
          targetId: projectId,
          before: settingsOf(before.buildSettings),
          after: settings,
          request,
        }),
      },
    },
  });
  return buildView(projectId);
}
