import { workloadSlugFor } from "@udp/config";
import {
  goldenPathFiles,
  isGoldenPathRuntime,
  scanRepository,
  type ScanContext,
} from "@udp/golden-path";
import { AppError, ConflictError, UnprocessableError } from "@udp/http";
import type { RepoScanWire } from "@udp/shared-types/wire";
import { prisma } from "../../core/db.js";
import { bindingsOfProject } from "../capability/capability-binding.repository.js";
import { pipelineTemplate } from "../cicd/cicd.service.js";
import type { DomainAdapterRegistry } from "../domain/domain-adapter.registry.js";
import type { RepoSourceFactory } from "./repo-source.js";

/**
 * Golden Path (§11, Plan #48): cây tệp Create New Service và quét repo của Import Existing.
 *
 * Cả hai đi kèm pipeline của tool CI/CD đang bật khi sinh được — cùng `pipelineTemplate` mà route
 * `…/domains/CICD/pipeline-template` dùng, nên developer không bao giờ thấy hai pipeline khác nhau.
 */

/** Tệp pipeline trong repo theo tool — dòng đầu của mỗi template ghi đúng đường này (test canh) */
export const PIPELINE_PATHS: Readonly<Record<string, string>> = {
  "github-actions": ".github/workflows/udp.yml",
  "gitlab-ci": ".gitlab-ci.yml",
  circleci: ".circleci/config.yml",
  jenkins: "Jenkinsfile",
  tekton: "tekton/udp-pipeline.yaml",
  drone: ".drone.yml",
};

interface PipelineFile {
  provider: string;
  path: string;
  content: string;
}

/** Pipeline sinh được, hoặc lý do không (chưa bật CI/CD, chưa có registry) */
async function pipelineOf(
  projectId: string,
  registry: DomainAdapterRegistry,
): Promise<{ pipeline: PipelineFile | null; note?: string }> {
  try {
    const { provider, content } = await pipelineTemplate(projectId, registry);
    return {
      pipeline: {
        provider,
        path: PIPELINE_PATHS[provider] ?? `udp-pipeline-${provider}`,
        content,
      },
    };
  } catch (err) {
    // 409 của pipelineTemplate là trạng thái project, không phải lỗi của lời gọi này
    if (err instanceof AppError && err.statusCode === 409) {
      return { pipeline: null, note: `Chưa có pipeline: ${err.message}` };
    }
    throw err;
  }
}

async function contextOf(
  projectId: string,
  name: string,
): Promise<ScanContext> {
  const bindings = await bindingsOfProject(prisma, projectId);
  return {
    slug: workloadSlugFor(name),
    registryRef:
      bindings.find((b) => b.capabilityId === "registry.oci")?.endpoint ?? null,
  };
}

export async function goldenPath(
  projectId: string,
  registry: DomainAdapterRegistry,
) {
  const project = await prisma.project.findUniqueOrThrow({
    where: { id: projectId },
    select: { name: true, languageRuntime: true },
  });
  const runtime = project.languageRuntime;
  if (!isGoldenPathRuntime(runtime)) {
    throw new UnprocessableError(
      `Golden Path chỉ có cho Node.js và Python (§16): project dùng runtime "${runtime}"`,
    );
  }
  const context = await contextOf(projectId, project.name);
  const { pipeline, note } = await pipelineOf(projectId, registry);
  const notes = [
    ...(note === undefined ? [] : [note]),
    ...(context.registryRef === null
      ? [
          "Chưa có Container Registry: thay REGISTRY_REF trong k8s/deployment.yaml bằng registry thật",
        ]
      : []),
  ];
  return {
    runtime,
    slug: context.slug,
    files: goldenPathFiles({ runtime, ...context }),
    pipeline,
    notes,
  };
}

export async function lastScan(
  projectId: string,
): Promise<{ scan: RepoScanWire | null }> {
  const project = await prisma.project.findUniqueOrThrow({
    where: { id: projectId },
    select: { repoScan: true },
  });
  return { scan: (project.repoScan as RepoScanWire | null) ?? null };
}

/**
 * Quét repo của project Import Existing rồi lưu kết quả MỚI NHẤT (thẻ trên Tổng quan đọc nó). Đề xuất
 * pipeline mang tệp mà adapter CI/CD đang bật sinh ra. Không bao giờ ghi vào repo.
 */
export async function scan(
  projectId: string,
  token: string | undefined,
  repoSource: RepoSourceFactory,
  registry: DomainAdapterRegistry,
): Promise<{ scan: RepoScanWire }> {
  const project = await prisma.project.findUniqueOrThrow({
    where: { id: projectId },
    select: { name: true, creationMode: true, repoUrl: true },
  });
  if (project.creationMode !== "IMPORT_EXISTING" || project.repoUrl === null) {
    throw new ConflictError(
      "Chỉ project Import Existing có repo để quét: project Create New dùng Golden Path",
    );
  }
  const { host, source } = repoSource(project.repoUrl, token);
  const [result, { pipeline }] = await Promise.all([
    contextOf(projectId, project.name).then((ctx) =>
      scanRepository(source, ctx),
    ),
    pipelineOf(projectId, registry),
  ]);
  const findings = result.findings.map((f) =>
    f.id === "pipeline" && f.status !== "ok" && pipeline !== null
      ? {
          ...f,
          suggestion: {
            text: `Dùng pipeline ${pipeline.provider} mà UDP sinh (bước cuối ký và báo deploy)`,
            file: { path: pipeline.path, content: pipeline.content },
          },
        }
      : f,
  );
  const saved: RepoScanWire = {
    scannedAt: new Date().toISOString(),
    repoUrl: project.repoUrl,
    host,
    runtime: result.runtime,
    framework: result.framework,
    cicdTool: result.cicdTool,
    findings,
    flagLevelReady: result.flagLevelReady,
    truncated: result.truncated,
  };
  await prisma.project.update({
    where: { id: projectId },
    data: { repoScan: saved },
  });
  return { scan: saved };
}
