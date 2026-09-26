import { DOMAIN_ERROR_SLUGS } from "@udp/shared-types/domain-api";
import type { CostWire } from "@udp/shared-types/wire";
import { ConflictError, ServiceUnavailableError } from "@udp/http";
import { z } from "zod";
import { prisma } from "../../core/db.js";
import type { WithCluster } from "../../core/app-deps.js";
import { bindingsOfProject } from "../capability/capability-binding.repository.js";

/**
 * Chi phí THỰC của project (§5.5 Cost Management, Plan #38 QĐ-8): hỏi API `/allocation` của bộ
 * tính (OpenCost/Kubecost) qua proxy của API server — dịch vụ không mở ra Internet — gom theo
 * namespace, rồi đổi namespace thành environment của project.
 *
 * Nơi hỏi đọc từ binding `cost.query` (namespace, service, cổng, đường API) — không đoán theo tên
 * tool: đổi OpenCost sang Kubecost là đổi binding, không đổi mã ở đây.
 */

const costBinding = z.object({
  provider: z.string(),
  namespace: z.string(),
  service: z.string(),
  port: z.coerce.number().int().positive(),
  allocationPath: z.string().regex(/^\/[a-z/]+$/),
});

/** Hình chung của `/allocation/compute` (OpenCost) và `/model/allocation` (Kubecost) */
const allocationResponse = z.object({
  data: z.array(
    z.record(
      z
        .object({
          totalCost: z.number(),
          cpuCost: z.number().default(0),
          ramCost: z.number().default(0),
          pvCost: z.number().default(0),
          networkCost: z.number().default(0),
        })
        .passthrough(),
    ),
  ),
});

/** Làm tròn tới xu — số trên dây không mang nhiễu dấu phẩy động */
const cents = (v: number): number => Math.round(v * 100) / 100;

export async function projectCost(
  projectId: string,
  days: number,
  withCluster: WithCluster | null,
): Promise<CostWire> {
  const bindings = await bindingsOfProject(prisma, projectId);
  const raw = bindings.find((b) => b.capabilityId === "cost.query");
  const target = costBinding.safeParse(raw?.attributes);
  if (raw === undefined || !target.success) {
    throw new ConflictError("Project chưa bật Cost Management").withTypeSlug(
      DOMAIN_ERROR_SLUGS.costNotEnabled,
    );
  }
  if (withCluster === null) {
    throw new ServiceUnavailableError(
      "Tiến trình này không truy cập được cluster để hỏi chi phí",
    );
  }
  const environments = await prisma.environment.findMany({
    where: { projectId },
    select: { id: true, name: true, k8sNamespace: true },
    orderBy: { rank: "asc" },
  });

  const { namespace, service, port, allocationPath, provider } = target.data;
  const body = await withCluster(projectId, async (access) => {
    const res = await access.proxyService(
      { namespace, service, port, scheme: "http" },
      `${allocationPath}?window=${String(days)}d&aggregate=namespace&accumulate=true`,
    );
    if (!res.ok) {
      throw new ServiceUnavailableError(
        `${provider} trả ${String(res.status)} cho truy vấn chi phí`,
      );
    }
    return res.json();
  }).catch((e: unknown) => {
    if (e instanceof ServiceUnavailableError) throw e;
    // Cluster không chạm được, credential bị từ chối: không phải lỗi của người hỏi
    throw new ServiceUnavailableError(
      "Không hỏi được chi phí từ cluster của project",
    );
  });

  const parsed = allocationResponse.safeParse(body);
  if (!parsed.success) {
    throw new ServiceUnavailableError(
      `${provider} trả dữ liệu chi phí sai hình`,
    );
  }
  const byNamespace = new Map<
    string,
    z.infer<typeof allocationResponse>["data"][number][string]
  >();
  for (const set of parsed.data.data) {
    for (const [ns, a] of Object.entries(set)) {
      const prev = byNamespace.get(ns);
      byNamespace.set(
        ns,
        prev === undefined
          ? a
          : {
              ...a,
              totalCost: prev.totalCost + a.totalCost,
              cpuCost: prev.cpuCost + a.cpuCost,
              ramCost: prev.ramCost + a.ramCost,
              pvCost: prev.pvCost + a.pvCost,
              networkCost: prev.networkCost + a.networkCost,
            },
      );
    }
  }
  const perEnvironment = environments.map((e) => {
    const a = byNamespace.get(e.k8sNamespace);
    return {
      environmentId: e.id,
      name: e.name,
      totalUsd: cents(a?.totalCost ?? 0),
      cpuUsd: cents(a?.cpuCost ?? 0),
      ramUsd: cents(a?.ramCost ?? 0),
      storageUsd: cents(a?.pvCost ?? 0),
      networkUsd: cents(a?.networkCost ?? 0),
    };
  });
  return {
    provider,
    days,
    currency: "USD",
    totalUsd: cents(perEnvironment.reduce((sum, e) => sum + e.totalUsd, 0)),
    environments: perEnvironment,
  };
}
