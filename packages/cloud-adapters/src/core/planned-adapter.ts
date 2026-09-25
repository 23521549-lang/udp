import {
  idempotencyKeyOf,
  parseIdempotencyKey,
  quotaViolations,
  runTeardown,
  type CloudAdapter,
  type ClusterInfo,
  type CostEstimate,
  type CreatedResource,
  type CreatedResourceKind,
  type LookupOutcome,
  type NetworkInfo,
  type PreflightReport,
  type ProvisionClusterParams,
  type ProvisionedResourceRow,
  type ProvisionNetworkParams,
  type ResolvedCredential,
  type ResourceStep,
} from "@udp/adapter-core";
import type { AdapterResult } from "@udp/shared-types";
import {
  GatewayError,
  isGatewayError,
  safeMessage,
  type CloudGateway,
} from "./gateway.js";
import {
  CONTROL_PLANE_SERVICE_ACCOUNTS,
  planProblems,
  type ProviderPlan,
  type StepContext,
  type StepSpec,
} from "./plan.js";

/**
 * MỘT lõi điều phối cho cả ba Cloud Adapter (Plan #26 QĐ-2) — hiện thực đủ 10 phương thức
 * của `CloudAdapter` trên một `ProviderPlan` và một `CloudGateway`.
 *
 * Lõi giữ đúng ngữ nghĩa mà bộ hợp đồng Cloud kiểm trên adapter mô phỏng, và cố ý KHÔNG
 * thêm gì:
 * - không tự thử lại trong `create`/`lookup`: thử lại là việc của runner, và bộ hợp đồng
 *   đếm số lời gọi cloud — một vòng retry ở đây đổi con số đó mà không ai thấy;
 * - lookup lỗi là `indeterminate`, KHÔNG BAO GIỜ là `absent` (§4.2: runner bị cấm `create`
 *   khi bất định — coi lỗi là "không có" là tạo trùng hạ tầng trong tài khoản của khách);
 * - quét tag lỗi là `FAILED`, không phải danh sách rỗng (§4.2 `rebuildLedgerFromCloud`);
 * - teardown đi qua `runTeardown` của adapter-core: một thứ tự chín bậc, không hai. TRONG
 *   một bậc, tài nguyên được xoá theo thứ tự NGƯỢC kế hoạch: NAT trước địa chỉ IP nó giữ,
 *   subnet trước NSG gắn vào nó — xoá theo thứ tự tạo thì cloud từ chối vì "đang dùng"
 *   và tài nguyên thành mồ côi.
 */

export interface WaitReadyOptions {
  intervalMs: number;
  /** Mặc định cho mọi kind */
  timeoutMs: number;
  /** Kind chậm (cluster EKS ~15 phút) được hạn riêng */
  timeoutByKind?: Partial<Record<CreatedResourceKind, number>>;
}

export interface PlannedAdapterOptions {
  plan: ProviderPlan;
  /** Cổng cho MỘT credential — lõi gọi lại mỗi lần vì credential quyết định quyền */
  gatewayFor: (credential: ResolvedCredential) => CloudGateway;
  waitReady: WaitReadyOptions;
  teardown: { waitTimeoutMs: number; pollIntervalMs: number };
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

const ok = <T>(data: T): AdapterResult<T> => ({ status: "SUCCESS", data });
const failed = <T>(message: string): AdapterResult<T> => ({
  status: "FAILED",
  message,
});

const realSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export function createPlannedAdapter(
  options: PlannedAdapterOptions,
): CloudAdapter {
  const { plan, gatewayFor } = options;
  const problems = planProblems(plan);
  if (problems.length > 0) {
    throw new Error(`kế hoạch ${plan.provider} sai: ${problems.join("; ")}`);
  }
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? realSleep;

  const lookupByOf = (
    kind: CreatedResourceKind,
  ): "tag" | "deterministic-name" =>
    plan.kindsWithoutCreateTags.includes(kind) ? "deterministic-name" : "tag";

  const indeterminate = (e: unknown): LookupOutcome => ({
    kind: "indeterminate",
    reason: safeMessage(e),
  });

  const stepOf = (
    spec: StepSpec,
    ctx: StepContext,
    projectId: string,
    tags: Readonly<Record<string, string>>,
  ): ResourceStep => {
    const idempotencyKey = idempotencyKeyOf(
      projectId,
      spec.phase,
      spec.kind,
      spec.name,
    );
    const physicalName = plan.physicalName(projectId, spec.name);
    const lookupBy = lookupByOf(spec.kind);

    return {
      kind: spec.kind,
      name: spec.name,
      idempotencyKey,
      lookupBy,

      lookup: async (cred) => {
        try {
          const gateway = gatewayFor(cred);
          const found =
            lookupBy === "tag"
              ? ((await gateway.findByTag("udp.key", idempotencyKey))[0] ??
                null)
              : await gateway.findByName(spec.kind, physicalName);
          return found === null
            ? { kind: "absent" }
            : { kind: "found", resource: found };
        } catch (e) {
          return indeterminate(e);
        }
      },

      lookupById: async (cred, providerId) => {
        try {
          const r = await gatewayFor(cred).describe(spec.kind, providerId);
          return r === null
            ? { kind: "absent" }
            : { kind: "found", resource: r };
        } catch (e) {
          return indeterminate(e);
        }
      },

      create: async (cred, prior) => {
        const parents: Record<string, CreatedResource> = {};
        for (const name of spec.dependsOn) {
          const parent = prior[name];
          /**
           * [v4.11] Cha vắng là LỖI, không bỏ qua: bản trước im lặng bỏ, cổng mô phỏng không
           * đọc cha, và kế hoạch thật chỉ vỡ ở cloud thật — pha CLUSTER chạy tách khỏi pha
           * mạng mà không mang tài nguyên của nó (Plan #28 QĐ-3).
           */
          if (parent === undefined) {
            throw new GatewayError(
              "permanent",
              `step ${spec.name} thiếu tài nguyên cha ${name} trong prior`,
            );
          }
          parents[name] = parent;
        }
        return gatewayFor(cred).create({
          kind: spec.kind,
          name: spec.name,
          physicalName,
          idempotencyKey,
          spec: spec.build(ctx),
          tags: { ...tags, "udp.key": idempotencyKey },
          parents,
        });
      },

      waitReady: async (cred, r) => {
        const gateway = gatewayFor(cred);
        const timeout =
          options.waitReady.timeoutByKind?.[r.kind] ??
          options.waitReady.timeoutMs;
        const deadline = now() + timeout;
        for (;;) {
          if (await gateway.isReady(r)) return;
          if (now() >= deadline) {
            throw new Error(
              `${r.kind} ${r.id} chưa sẵn sàng sau ${String(timeout)} ms`,
            );
          }
          await sleep(options.waitReady.intervalMs);
        }
      },

      delete: async (cred, r) => {
        await gatewayFor(cred).remove(r);
      },
    };
  };

  const stepsFor = (
    specs: readonly StepSpec[],
    ctx: StepContext,
    projectId: string,
    tags: Readonly<Record<string, string>>,
  ): ResourceStep[] => specs.map((s) => stepOf(s, ctx, projectId, tags));

  const allSpecs = [...plan.networkSteps, ...plan.clusterSteps];
  const indexByStep = new Map(allSpecs.map((s, i) => [s.name, i]));
  const lastIndexByKind = new Map(allSpecs.map((s, i) => [s.kind, i]));

  /** Vị trí trong kế hoạch: theo tên step trong `udp.key`; kind không mang tag thì theo kind */
  const planPosition = (r: CreatedResource): number => {
    const step = parseIdempotencyKey(r.tags["udp.key"] ?? "")?.name;
    return (
      (step === undefined ? undefined : indexByStep.get(step)) ??
      lastIndexByKind.get(r.kind) ??
      -1
    );
  };

  return {
    providerId: plan.provider,

    validateCredential: async (credential) => {
      if (credential.expiresAt.getTime() <= now()) {
        return ok({ valid: false, reason: "credential đã hết hạn" });
      }
      try {
        await gatewayFor(credential).whoAmI();
        return ok({ valid: true });
      } catch (e) {
        if (
          isGatewayError(e) &&
          (e.errorClass === "permission" || e.errorClass === "configuration")
        ) {
          return ok({ valid: false, reason: safeMessage(e) });
        }
        return failed(safeMessage(e));
      }
    },

    preflightPermissions: async (credential) => {
      try {
        const check = await gatewayFor(credential).checkPermissions(
          plan.requiredPermissions,
        );
        const report: PreflightReport = {
          ok: check.missing.length === 0,
          confidence: check.confidence,
          missingPermissions: check.missing,
          quotaWarnings: check.quotaWarnings,
          docUrl: plan.docUrl,
        };
        return ok(report);
      } catch (e) {
        return failed(safeMessage(e));
      }
    },

    estimateCost: (params: ProvisionClusterParams) => {
      const violations = quotaViolations(
        { nodes: params.nodeCount, nodeSize: params.nodeSize },
        params.quota,
      );
      if (violations.length > 0) {
        return Promise.resolve(
          failed<CostEstimate>(
            `vượt quota: ${violations.map((v) => v.dimension).join(", ")}`,
          ),
        );
      }
      const p = plan.pricing;
      const breakdown = [
        { item: "control-plane", monthlyUsd: p.controlPlaneMonthlyUsd },
        { item: "nat-gateway", monthlyUsd: p.natGatewayMonthlyUsd },
        { item: "load-balancer", monthlyUsd: p.loadBalancerMonthlyUsd },
        {
          item: "nodes",
          monthlyUsd: p.nodeMonthlyUsd[params.nodeSize] * params.nodeCount,
        },
      ];
      return Promise.resolve(
        ok<CostEstimate>({
          monthlyUsd:
            Math.round(breakdown.reduce((a, b) => a + b.monthlyUsd, 0) * 100) /
            100,
          breakdown,
          isEstimate: true,
          pricingAsOf: p.asOf,
        }),
      );
    },

    networkSteps: (params: ProvisionNetworkParams) =>
      stepsFor(
        plan.networkSteps,
        { phase: "NETWORK", params },
        params.projectId,
        params.tags,
      ),

    clusterSteps: (params: ProvisionClusterParams, network: NetworkInfo) =>
      stepsFor(
        plan.clusterSteps,
        { phase: "CLUSTER", params, network },
        params.projectId,
        params.tags,
      ),

    getClusterStatus: async (credential, clusterId) => {
      try {
        const info = await gatewayFor(credential).clusterInfo(clusterId);
        return ok<ClusterInfo>({
          ...info,
          controlPlaneServiceAccounts: { ...CONTROL_PLANE_SERVICE_ACCOUNTS },
        });
      } catch (e) {
        return failed<ClusterInfo>(safeMessage(e));
      }
    },

    getKubeAuthToken: async (credential, cluster) => {
      try {
        return ok(await gatewayFor(credential).kubeToken(cluster));
      } catch (e) {
        return failed(safeMessage(e));
      }
    },

    listTaggedResources: async (credential, projectId) => {
      try {
        return ok(await gatewayFor(credential).listByProject(projectId));
      } catch (e) {
        return failed<CreatedResource[]>(safeMessage(e));
      }
    },

    rebuildLedgerFromCloud: async (credential, projectId) => {
      const gateway = gatewayFor(credential);
      let tagged: CreatedResource[];
      try {
        tagged = await gateway.listByProject(projectId);
      } catch (e) {
        // Quét lỗi KHÔNG phải "cloud rỗng": runner không được reconcile trên kết quả này
        return failed(safeMessage(e));
      }
      const rows: ProvisionedResourceRow[] = [];
      const unmatched: CreatedResource[] = [];
      for (const r of tagged) {
        const key = r.tags["udp.key"];
        const parsed = key === undefined ? null : parseIdempotencyKey(key);
        if (
          key === undefined ||
          parsed === null ||
          r.tags["udp.managed"] !== "true" ||
          parsed.projectId !== projectId
        ) {
          unmatched.push(r);
          continue;
        }
        rows.push({
          projectId,
          step: parsed.step,
          kind: r.kind,
          idempotencyKey: key,
          providerId: r.id,
          provider: r.provider,
          region: r.region,
          status: "READY",
        });
      }
      // Đường thứ hai: kind không mang được tag ⇒ tra theo tên tất định (§4.2 v4.10)
      const seen = new Set(rows.map((r) => r.providerId));
      for (const spec of allSpecs) {
        if (lookupByOf(spec.kind) !== "deterministic-name") continue;
        let found: CreatedResource | null;
        try {
          found = await gateway.findByName(
            spec.kind,
            plan.physicalName(projectId, spec.name),
          );
        } catch (e) {
          return failed(safeMessage(e));
        }
        if (found === null || seen.has(found.id)) continue;
        rows.push({
          projectId,
          step: spec.phase,
          kind: spec.kind,
          idempotencyKey: idempotencyKeyOf(
            projectId,
            spec.phase,
            spec.kind,
            spec.name,
          ),
          providerId: found.id,
          provider: found.provider,
          region: found.region,
          status: "READY",
        });
      }
      return ok({ rows, unmatched });
    },

    teardown: async (credential, resources) => {
      const gateway = gatewayFor(credential);
      const kindOf = new Map(resources.map((r) => [r.id, r.kind]));
      const outcome = await runTeardown({
        // `runTeardown` giữ thứ tự đầu vào trong mỗi bậc
        resources: [...resources].sort(
          (a, b) => planPosition(b) - planPosition(a),
        ),
        cloud: {
          deleteResource: (r) => gateway.remove(r),
          describeById: (id) => {
            const kind = kindOf.get(id);
            return kind === undefined
              ? Promise.resolve(null)
              : gateway.describe(kind, id);
          },
        },
        waitTimeoutMs: options.teardown.waitTimeoutMs,
        pollIntervalMs: options.teardown.pollIntervalMs,
        now,
        sleep,
      });
      return ok({
        deleted: [...outcome.deleted],
        failed: outcome.orphans.map((o) => o.resource.id),
      });
    },
  };
}
