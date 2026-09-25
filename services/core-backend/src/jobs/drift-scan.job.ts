import type {
  ClusterAccess,
  DomainAdapter,
  DomainAdapterContext,
} from "@udp/adapter-core";
import { SYSTEM_NAMESPACE } from "../modules/cluster/bootstrap.js";
import { bindingsOfProject } from "../modules/capability/capability-binding.repository.js";
import {
  activeDomainsOfProject,
  writeDriftRecord,
} from "../modules/day2/domain-config.repository.js";
import {
  scanDomainDrift,
  type DriftScanOutcome,
} from "../modules/day2/drift-scan.js";
import {
  perEnvironment,
  providesRegistry,
  resolvedFor,
} from "../modules/provisioning/domain-phase.js";
import {
  pullCredentialsOf,
  withRegistryPullDrift,
} from "../modules/adapter-base/registry-pull.js";
import { openSecrets } from "../modules/domain/tool-secrets.js";
import { tagsOf } from "../modules/provisioning/provision-plan.js";
import { messageOf, type JobInput, type JobKit } from "./job-kit.js";

/**
 * Lịch `drift-scan` (§8.6 nhánh A, Plan #29): quét domain ACTIVE của mọi
 * project ACTIVE qua `scanDomainDrift` — chỗ DUY NHẤT hạ bối cảnh xuống chỉ đọc, và chỉ ghi
 * `last_error` khi phán quyết đổi (I32 chiều c). Không bao giờ tự sửa.
 *
 * Adapter theo namespace cài vào MỖI environment, nên một lượt quét hỏi nó trên từng
 * environment rồi gộp: trôi ở bất kỳ đâu là trôi, kèm tên environment trong chi tiết.
 * Không chạm được cluster ⇒ mọi domain của project nhận `SCAN_FAILED` (tên lỗi, không thông
 * điệp — §12 T3), không phải "sạch".
 */

export class ClusterUnreachableError extends Error {
  constructor() {
    super("không chạm được cluster của project");
    this.name = "ClusterUnreachableError";
  }
}

export interface DriftSweepOutcome {
  scanned: DriftScanOutcome[];
  skipped: { projectId: string; reason: string }[];
}

export async function sweepDrift(
  kit: JobKit,
  options: {
    /** Giới hạn lượt quét vào các project này — test và "quét ngay" dùng */
    only?: readonly string[];
    /** Chỉ một domain — route quét ngay (Plan #30 QĐ-4) */
    domainType?: string;
  } = {},
): Promise<DriftSweepOutcome> {
  const { prisma } = kit.deps;
  const out: DriftSweepOutcome = { scanned: [], skipped: [] };
  const projects = await prisma.project.findMany({
    where: {
      status: "ACTIVE",
      ...(options.only === undefined ? {} : { id: { in: [...options.only] } }),
    },
    select: { id: true },
  });
  const registry = await kit.deps.domainRegistry();

  for (const { id: projectId } of projects) {
    // Adapter so cấu hình mong muốn với cluster: cần bản RÕ, chỉ trong bộ nhớ
    const active = (await activeDomainsOfProject(prisma, projectId)).map(
      (r) => ({
        ...r,
        toolConfig: openSecrets(
          { projectId, domainType: r.domainType },
          r.toolConfig,
        ),
      }),
    );
    const rows = active.filter(
      (r) =>
        options.domainType === undefined || r.domainType === options.domainType,
    );
    // Khoá kéo mong muốn gộp từ MỌI registry đang bật — dù lượt quét chỉ nhắm một domain
    const pullCredentials = pullCredentialsOf(
      active.map((r) => ({
        pullCredential: registry
          .all()
          .find((l) => l.adapter === registry.get(r.domainType, r.selectedTool))
          ?.pullCredential,
        config: r.toolConfig,
      })),
    );
    const job = await prisma.provisioningJob.findFirst({
      where: { projectId, jobType: "PROVISION", state: "DONE" },
      orderBy: { createdAt: "desc" },
      select: { id: true },
    });
    if (rows.length === 0 || job === null) continue;
    try {
      const input = await kit.load(job.id);
      const scanned = await kit.withCredential(
        projectId,
        async (credential) => {
          const access: ClusterAccess | null = await kit.clusterAccessOf(
            input,
            credential,
          );
          const stored = await bindingsOfProject(prisma, projectId);
          const contextFor = (): Promise<DomainAdapterContext> =>
            access === null
              ? Promise.reject(new ClusterUnreachableError())
              : Promise.resolve({
                  k8s: access,
                  systemNamespace: SYSTEM_NAMESPACE,
                  region: input.payload.region,
                  quota: input.payload.quota,
                  resolved: resolvedFor(stored, {}, null),
                  tags: tagsOf(projectId, input.payload),
                  progress: (m: string) => {
                    kit.log(job.id, m);
                  },
                  fetch: kit.deps.egressFetch,
                });
          return scanDomainDrift(rows, {
            adapterFor: (domainType, toolId) => {
              const adapter = registry.get(domainType, toolId);
              if (adapter === undefined) return undefined;
              const scanned = perEnvironment(adapter, input.environments);
              return providesRegistry(adapter)
                ? withRegistryPullDrift(
                    scanned,
                    input.environments.map((e) => e.k8sNamespace),
                    pullCredentials,
                  )
                : scanned;
            },
            contextFor,
            writeDrift: (id, record) => writeDriftRecord(prisma, id, record),
          });
        },
      );
      out.scanned.push(...scanned);
    } catch (e) {
      out.skipped.push({ projectId, reason: messageOf(e) });
    }
  }
  return out;
}
