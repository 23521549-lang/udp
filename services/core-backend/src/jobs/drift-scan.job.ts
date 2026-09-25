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
import { resolvedFor } from "../modules/provisioning/domain-phase.js";
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

/** Gộp `detectDrift` của một adapter theo namespace qua mọi environment */
function perEnvironment(
  adapter: DomainAdapter,
  input: JobInput,
): DomainAdapter {
  if (adapter.scope === "cluster") return adapter;
  return {
    ...adapter,
    detectDrift: async (ctx, config) => {
      const drifted: string[] = [];
      for (const environment of input.environments) {
        const res = await adapter.detectDrift({ ...ctx, environment }, config);
        if (res.status !== "SUCCESS" || res.data === undefined) return res;
        if (res.data.drifted) {
          drifted.push(
            `${environment.name}: ${res.data.details ?? "đã trôi cấu hình"}`,
          );
        }
      }
      return {
        status: "SUCCESS",
        data:
          drifted.length === 0
            ? { drifted: false }
            : { drifted: true, details: drifted.join("; ") },
      };
    },
  };
}

export async function sweepDrift(
  kit: JobKit,
  options: {
    /** Giới hạn lượt quét vào các project này — test dùng, lịch thật quét hết */
    only?: readonly string[];
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
    const rows = await activeDomainsOfProject(prisma, projectId);
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
              return adapter === undefined
                ? undefined
                : perEnvironment(adapter, input);
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
