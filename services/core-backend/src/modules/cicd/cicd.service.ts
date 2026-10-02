import { env, workloadSlugFor } from "@udp/config";
import type { DomainToolConfig, PipelineStep } from "@udp/adapter-core";
import type { Prisma } from "@udp/db";
import { ConflictError, NotFoundError } from "@udp/http";
import type {
  CicdSecretResponseWire,
  CicdStatusWire,
} from "@udp/shared-types/wire";
import type { Request } from "express";
import { prisma } from "../../core/db.js";
import { buildPlanOf } from "../packaging/build-plan.js";
import { scannedLanguageOf } from "../packaging/scanned-language.js";
import { providerFromDb } from "../provisioning/provider-codec.js";
import { API_PREFIX } from "../../core/http/api-prefix.js";
import { auditEntry } from "../audit/audit.service.js";
import { bindingsOfProject } from "../capability/capability-binding.repository.js";
import { activeMeta } from "../cloud/cloud.repository.js";
import type { DomainAdapterRegistry } from "../domain/domain-adapter.registry.js";
import { isCicdAdapter } from "./cicd-webhook.service.js";
import {
  absoluteWebhookUrlOf,
  expectationOf,
  webhookPathOf,
} from "./trusted-deploy.js";
import {
  generateWebhookSecret,
  isSealedWebhookSecret,
  sealWebhookSecret,
} from "./webhook-secret.js";

/**
 * Phía quản trị của CI/CD (§8.3, Plan #36 QĐ-2): trạng thái, sinh/xoay secret webhook (hiện MỘT
 * lần), template pipeline Golden Path của tool đang bật.
 */

const enabledCicd = (projectId: string) =>
  prisma.domainConfig.findFirst({
    where: { projectId, domainType: "CICD", isEnabled: true },
    select: {
      id: true,
      selectedTool: true,
      webhookSecret: true,
      toolConfig: true,
      oidcRequired: true,
    },
  });

async function cicdRowOf(projectId: string) {
  const row = await enabledCicd(projectId);
  if (row?.selectedTool == null) {
    throw new ConflictError("Project chưa bật domain CI/CD");
  }
  return { ...row, provider: row.selectedTool };
}

/**
 * Trusted Deploy khả dụng chưa, và nếu chưa thì vì sao — Portal nói lại nguyên văn lý do.
 *
 * `available` false nghĩa là UDP KHÔNG kiểm được token của provider đang bật, nên KHÔNG được cho bật chế
 * độ bắt buộc: bật một cổng mà UDP không kiểm nổi là tự khoá project ra ngoài, và đó là một trạng thái
 * chỉ sửa được bằng tay trong database.
 */
export function trustedDeployStateOf(row: {
  selectedTool: string | null;
  toolConfig: unknown;
  oidcRequired: boolean;
}): CicdStatusWire["trustedDeploy"] {
  const provider = row.selectedTool;
  const expectation =
    provider === null
      ? { unavailable: "NO_PROVIDER" as const }
      : expectationOf({
          provider,
          toolConfig: row.toolConfig,
          // `aud` không ảnh hưởng tới việc provider có kiểm được hay không, nên chỗ này chỉ cần một chuỗi
          // hợp lệ; chuỗi thật dựng ở đường webhook.
          audience: "https://unused.invalid",
        });
  return "unavailable" in expectation
    ? {
        required: row.oidcRequired,
        available: false,
        unavailableReason: expectation.unavailable,
      }
    : { required: row.oidcRequired, available: true, unavailableReason: null };
}

export async function status(projectId: string): Promise<CicdStatusWire> {
  const row = await enabledCicd(projectId);
  const provider = row?.selectedTool ?? null;
  return {
    provider,
    webhookPath: provider === null ? null : webhookPathOf(projectId, provider),
    webhookUrl:
      provider === null ? null : absoluteWebhookUrlOf(projectId, provider),
    secretSet: isSealedWebhookSecret(row?.webhookSecret),
    trustedDeploy: trustedDeployStateOf({
      selectedTool: provider,
      toolConfig: row?.toolConfig ?? null,
      oidcRequired: row?.oidcRequired ?? false,
    }),
  };
}

/** Sinh (hay xoay) secret — giá trị rõ CHỈ có trong response này; audit không mang nó */
export async function rotateSecret(
  projectId: string,
  request: Request,
): Promise<CicdSecretResponseWire> {
  const row = await cicdRowOf(projectId);
  const secret = generateWebhookSecret();
  await prisma.$transaction([
    prisma.domainConfig.update({
      where: { id: row.id },
      data: {
        webhookSecret: sealWebhookSecret(
          projectId,
          secret,
        ) as unknown as Prisma.InputJsonObject,
      },
    }),
    prisma.auditLog.create({
      data: {
        projectId,
        ...auditEntry({
          action: isSealedWebhookSecret(row.webhookSecret)
            ? "cicd.webhook_secret.rotate"
            : "cicd.webhook_secret.create",
          targetType: "DomainConfig",
          targetId: row.id,
          after: { provider: row.provider },
          request,
        }),
      },
    }),
  ]);
  return {
    provider: row.provider,
    webhookPath: webhookPathOf(projectId, row.provider),
    secret,
  };
}

/**
 * Template pipeline của tool CI đang bật. Registry lấy từ binding `registry.oci` (luật §5.2 — không
 * đoán), flag gắn nhãn `ff` là các flag đang theo dõi ở bất kỳ environment nào, workload là slug
 * của tên project (container cùng tên — thứ job deploy đổi image).
 */
export async function pipelineTemplate(
  projectId: string,
  registry: DomainAdapterRegistry,
) {
  const row = await cicdRowOf(projectId);
  const adapter = registry.get("CICD", row.provider);
  if (!isCicdAdapter(adapter)) {
    throw new NotFoundError(`Không có adapter CI/CD ${row.provider}`);
  }
  const [project, bindings, tracked, enabled, credential] = await Promise.all([
    prisma.project.findUniqueOrThrow({
      where: { id: projectId },
      select: {
        name: true,
        languageRuntime: true,
        buildSettings: true,
        repoScan: true,
        environments: {
          select: { name: true, isProduction: true },
          orderBy: { rank: "asc" },
        },
      },
    }),
    bindingsOfProject(prisma, projectId),
    prisma.flagEnvConfig.findMany({
      where: { isTracked: true, environment: { projectId } },
      select: { flag: { select: { key: true } } },
      distinct: ["flagId"],
    }),
    prisma.domainConfig.findMany({
      where: { projectId, isEnabled: true, selectedTool: { not: null } },
      select: { domainType: true, selectedTool: true, toolConfig: true },
    }),
    // [Plan #61 QĐ-14] Cloud của project: danh tính ký và khoá KMS nằm ở đó
    activeMeta(projectId),
  ]);
  const registryBinding = bindings.find(
    (b) => b.capabilityId === "registry.oci",
  );
  const registryRef = registryBinding?.endpoint;
  if (registryRef == null) {
    throw new ConflictError(
      "Chưa có registry.oci — bật một Container Registry trước khi sinh pipeline",
    );
  }
  const projectSlug = workloadSlugFor(project.name);
  return {
    provider: row.provider,
    content: adapter.renderPipelineTemplate({
      projectSlug,
      steps: stepsOfEnabled(registry, enabled, projectSlug),
      environments: project.environments,
      registryRef,
      languageRuntime: project.languageRuntime,
      // [Plan #61] Build thế nào: chiến lược, đăng nhập registry, danh tính build, bước test
      build: buildPlanOf({
        languageRuntime: project.languageRuntime,
        registry: registryBinding,
        settings: project.buildSettings,
        scannedLanguage: scannedLanguageOf(project.repoScan),
        projectCloud:
          credential === null ? null : providerFromDb(credential.provider),
        ci: row.provider,
      }),
      flagKeys: tracked.map((t) => t.flag.key).sort(),
      rolloutStrategy: bindings.some(
        (b) => b.capabilityId === "traffic.control",
      )
        ? "tool-driven"
        : "udp-driven",
    }),
  };
}

/**
 * Bước mà các tool đang bật góp vào pipeline (Plan #37 QĐ-2). Không cần mở bí mật: registry đã
 * cấm trường bí mật ở mọi adapter xuất `pipelineSteps`.
 */
function stepsOfEnabled(
  registry: DomainAdapterRegistry,
  rows: {
    domainType: string;
    selectedTool: string | null;
    toolConfig: unknown;
  }[],
  projectSlug: string,
): PipelineStep[] {
  return rows.flatMap((row) => {
    const adapter = registry.get(row.domainType, row.selectedTool ?? "");
    const declared = registry
      .all()
      .find((l) => l.adapter === adapter)?.pipelineSteps;
    if (declared === undefined) return [];
    const config =
      typeof row.toolConfig === "object" && row.toolConfig !== null
        ? (row.toolConfig as DomainToolConfig)
        : {};
    return declared(config, { slug: projectSlug });
  });
}
