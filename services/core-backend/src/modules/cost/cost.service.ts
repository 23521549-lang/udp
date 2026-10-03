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

/**
 * Hình chung của `/allocation/compute` (OpenCost) và `/model/allocation` (Kubecost). Với
 * `accumulate=false&step=1d` mỗi phần tử của `data` là MỘT ngày; `window.start` nói ngày nào.
 */
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
          window: z
            .object({ start: z.string().optional() })
            .passthrough()
            .optional(),
        })
        .passthrough(),
    ),
  ),
});

/** Làm tròn tới xu — số trên dây không mang nhiễu dấu phẩy động */
const cents = (v: number): number => Math.round(v * 100) / 100;

const DAY_MS = 86_400_000;
const isoDay = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

/**
 * Chia `totalCents` cho các phần theo tỉ lệ số thật `exact` (phần dư lớn nhất): mỗi phần là số xu
 * nguyên và tổng các phần ĐÚNG BẰNG `totalCents` — làm tròn từng ngày riêng rẽ sẽ lệch tổng vài xu,
 * và một biểu đồ mà cộng lại không ra con số bên cạnh là một biểu đồ người ta thôi tin.
 */
export function apportionCents(
  exact: readonly number[],
  totalCents: number,
): number[] {
  const sum = exact.reduce((s, v) => s + Math.max(0, v), 0);
  if (sum <= 0 || totalCents <= 0) return exact.map(() => 0);
  const shares = exact.map((v) => (Math.max(0, v) / sum) * totalCents);
  const base = shares.map((s) => Math.floor(s));
  let left = totalCents - base.reduce((s, v) => s + v, 0);
  const order = shares
    .map((s, i) => ({ i, frac: s - Math.floor(s) }))
    .sort((a, b) => b.frac - a.frac || a.i - b.i);
  for (const { i } of order) {
    if (left <= 0) break;
    base[i] = (base[i] ?? 0) + 1;
    left -= 1;
  }
  return base;
}

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
      `${allocationPath}?window=${String(days)}d&aggregate=namespace&accumulate=false&step=1d`,
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
  const totalUsd = cents(
    perEnvironment.reduce((sum, e) => sum + e.totalUsd, 0),
  );
  const namespaces = new Set(environments.map((e) => e.k8sNamespace));
  /**
   * Một ngày = một tập của bộ tính; ngày của tập lấy từ `window.start`, thiếu thì đếm lùi từ hôm
   * nay (tập cuối là hôm nay). Chỉ namespace của project được cộng — như tổng ở trên.
   */
  const today = Math.floor(Date.now() / DAY_MS) * DAY_MS;
  const sets = parsed.data.data;
  const perDay = sets.map((set, i) => {
    const allocations = Object.entries(set);
    const start = allocations.find(
      ([, a]) => a.window?.start !== undefined,
    )?.[1].window?.start;
    const at =
      start === undefined || Number.isNaN(Date.parse(start))
        ? today - (sets.length - 1 - i) * DAY_MS
        : Date.parse(start);
    return {
      date: isoDay(at),
      exact: allocations
        .filter(([ns]) => namespaces.has(ns))
        .reduce((s, [, a]) => s + a.totalCost, 0),
    };
  });
  const dailyCents = apportionCents(
    perDay.map((d) => d.exact),
    Math.round(totalUsd * 100),
  );
  return {
    provider,
    days,
    currency: "USD",
    totalUsd,
    environments: perEnvironment,
    daily: perDay.map((d, i) => ({
      date: d.date,
      totalUsd: (dailyCents[i] ?? 0) / 100,
    })),
  };
}
