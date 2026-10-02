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
  IN_CLUSTER_CI,
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
 * [Plan #61 61d-2b-1] Project đã có cụm dùng được chưa — ĐÚNG vị từ mà đường ra cụm dùng.
 *
 * Không phải một phép kiểm xấp xỉ: `clusterOf` của `job-kit` tìm chính hàng này (`kind === "cluster"`,
 * `status === "READY"`, có `providerId`) rồi mới dựng `ClusterAccess`. Hỏi một câu khác ở đây — ví dụ "có
 * job PROVISION nào DONE chưa" — sẽ cho Portal nói "khả dụng" trong khi đường xác minh vẫn trả 503.
 */
const clusterReadyFor = async (
  tx: Pick<typeof prisma, "provisionedResource">,
  projectId: string,
): Promise<boolean> =>
  (await tx.provisionedResource.count({
    where: {
      projectId,
      kind: "cluster",
      status: "READY",
      providerId: { not: null },
    },
  })) > 0;

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
  /**
   * [61d-2b-1] Project đã có cụm provision xong chưa.
   *
   * Vì sao là một ĐẦU VÀO chứ không tra ở đây: hàm này thuần và đồng bộ, và nó được gọi từ hai chỗ
   * (`status` và `setOidcRequired`) — mỗi chỗ đã có transaction và truy vấn riêng. Tra database bên trong
   * sẽ biến một hàm thuần thành một hàm I/O mà hai bên gọi không điều khiển được.
   *
   * Chỉ nhánh CI-trong-cụm đọc nó: ba CI SaaS kiểm được token mà không cần cụm nào.
   */
  clusterReady: boolean;
}): CicdStatusWire["trustedDeploy"] {
  const provider = row.selectedTool;
  const expectation =
    provider === null
      ? { unavailable: "NO_PROVIDER" as const }
      : expectationOf({
          provider,
          toolConfig: row.toolConfig,
          // Chuỗi này không ảnh hưởng tới việc provider có kiểm được hay không (câu hỏi duy nhất ở đây),
          // nên chỉ cần một giá trị hợp lệ; chuỗi thật dựng ở đường webhook từ `absoluteWebhookUrlOf`.
          webhookUrl: "https://unused.invalid",
        });
  if ("unavailable" in expectation) {
    return {
      required: row.oidcRequired,
      available: false,
      unavailableReason: expectation.unavailable,
    };
  }
  // Khoá kiểm của CI trong cụm nằm Ở CHÍNH cụm của project, nên chưa có cụm là chưa kiểm được
  if (expectation.kind === "cluster" && !row.clusterReady) {
    return {
      required: row.oidcRequired,
      available: false,
      unavailableReason: "CLUSTER_NOT_READY",
    };
  }
  return {
    required: row.oidcRequired,
    available: true,
    unavailableReason: null,
  };
}

export async function status(projectId: string): Promise<CicdStatusWire> {
  const row = await enabledCicd(projectId);
  const provider = row?.selectedTool ?? null;
  // Chỉ hỏi database thêm một câu khi provider LÀ một CI trong cụm — ba CI SaaS không cần cụm nào
  const clusterReady =
    provider !== null && IN_CLUSTER_CI.some((name: string) => name === provider)
      ? await clusterReadyFor(prisma, projectId)
      : false;
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
      clusterReady,
    }),
  };
}

/**
 * [Plan #61 QĐ-17, 61d-2a] Bật/tắt Trusted Deploy bằng tay — MAINTAINER, có nhật ký.
 *
 * Một thao tác RIÊNG, đúng khuôn `signing-enforce` của 61d-1: không đi kèm việc lưu cấu hình domain, để
 * một Portal mở từ trước lúc UDP tự bật không vô tình tắt nó khi lưu thứ khác.
 *
 * Hai tiền điều kiện, và cả hai đều nhắm vào một trạng thái không sửa được từ UI:
 *  - Không cho BẬT khi UDP chưa kiểm được token của provider đang bật (CircleCI thiếu hai id, hay provider
 *    là một CI chạy trong cụm — chờ 61d-2b). Bật một cổng mà UDP không kiểm nổi là tự khoá project ra
 *    ngoài. Cùng lý lẽ với `setSigningEnforce` từ chối bật khi chưa có khoá.
 *  - TẮT thì không có tiền điều kiện nào: nó là van xả, và một van xả có điều kiện thì không phải van xả.
 *
 * Khoá hàng `domain_configs` bằng `FOR NO KEY UPDATE` trong transaction: đường webhook đọc hàng đó NGOÀI
 * transaction của nó, nên hai lượt đi qua nhau sẽ ghi đè kết luận của nhau.
 */
export async function setOidcRequired(
  projectId: string,
  required: boolean,
  request: Request,
): Promise<CicdStatusWire> {
  await prisma.$transaction(async (tx) => {
    const [locked] = await tx.$queryRaw<
      {
        id: string;
        selected_tool: string | null;
        tool_config: unknown;
        oidc_required: boolean;
      }[]
    >`
      SELECT id, selected_tool, tool_config, oidc_required
        FROM domain_configs
       WHERE project_id = ${projectId}::uuid
         AND domain_type = 'CICD'
         AND is_enabled = true
       FOR NO KEY UPDATE`;
    if (locked === undefined || locked.selected_tool === null) {
      throw new ConflictError("Project chưa bật domain CI/CD");
    }
    if (locked.oidc_required === required) return;
    if (required) {
      const state = trustedDeployStateOf({
        selectedTool: locked.selected_tool,
        toolConfig: locked.tool_config,
        oidcRequired: locked.oidc_required,
        // Đọc trong CÙNG transaction đang giữ hàng CICD: một lượt gỡ cụm đi qua giữa hai câu sẽ cho bật
        // một cổng mà UDP không kiểm nổi
        clusterReady: await clusterReadyFor(tx, projectId),
      });
      if (!state.available) {
        throw new ConflictError(
          `UDP chưa kiểm được token của CI đang bật (${state.unavailableReason ?? "?"}): bật Trusted Deploy lúc này sẽ chặn mọi lần deploy`,
        );
      }
    }
    await tx.domainConfig.update({
      where: { id: locked.id },
      data: {
        oidcRequired: required,
        project: {
          update: {
            auditLogs: {
              create: auditEntry({
                action: required
                  ? "cicd.trusted-deploy.required"
                  : "cicd.trusted-deploy.unrequired",
                targetType: "Project",
                targetId: projectId,
                before: { required: !required },
                after: { required },
                request,
              }),
            },
          },
        },
      },
    });
  });
  return await status(projectId);
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
      webhookUrl: absoluteWebhookUrlOf(projectId, row.provider),
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
