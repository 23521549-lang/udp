import type { AdapterResult } from "@udp/shared-types";
import type {
  CloudAdapter,
  ClusterInfo,
  CostEstimate,
  CreatedResource,
  CreatedResourceKind,
  LookupOutcome,
  NetworkInfo,
  PreflightReport,
  ProvisionClusterParams,
  ProvisionNetworkParams,
  ResourceStep,
} from "../cloud.js";
import { expectedTagKeys } from "../cloud.js";
import type { ResolvedCredential } from "../credential.js";
import { quotaViolations } from "../guardrails.js";
import type { ProvisionedResourceRow, ProvisionStep } from "../ledger.js";
import { runTeardown } from "../teardown.js";
import { FIXTURE_STEPS } from "./fixture.js";
import { KINDS_WITHOUT_CREATE_TAGS, SimCloud } from "./sim-cloud.js";

/**
 * [v4.10] Hai adapter tham chiếu chạy trên cloud mô phỏng.
 *
 * Vì sao HAI chứ không một: bộ hợp đồng chạy với một adapter duy nhất thì nó là test của
 * adapter đó, không phải một hợp đồng. Hai adapter khác nhau ở đúng chiều mà §4.5 quy tắc 2
 * nói tới — một khai `lookupBy: "tag"`, một khai `"deterministic-name"` — nên đường tra cứu
 * dự phòng được chạy thật thay vì được hứa.
 *
 * Vì sao chúng KHÔNG gọi SDK cloud thật: không có cách kiểm chứng nào trên máy này, và một
 * adapter chưa từng chạy mà bị đóng băng bằng git tag là đóng băng một giả thuyết — nó làm
 * kiểm soát (a) của E1 báo số sai theo hướng có lợi cho mình. Nợ đã ghi: `I31-localstack`,
 * `I31-aws-eks`.
 *
 * Hai ràng buộc mà lớp này cố tình tự áp:
 *
 *  1. `rebuildLedgerFromCloud` **không đọc sổ, không đọc database**, không dùng một map nào
 *     sống trong adapter. Nó đọc cloud bằng HAI đường: quét tag, và dò theo tên tất định
 *     cho những `kind` mà API không cho gắn tag lúc tạo. Đường thứ hai là bắt buộc, không
 *     phải tuỳ chọn: một `kind` không mang tag thì quét tag bỏ sót nó IM LẶNG, và hàm vẫn
 *     trả `SUCCESS` với một sổ thiếu (v4.10 sửa §4.2).
 *  2. `listTaggedResources` **đi hết phân trang**. Trang cỡ 2 của cloud mô phỏng có chủ
 *     đích: một hiện thực chỉ đọc trang đầu vẫn "thành công" nhưng dựng lại một sổ thiếu.
 */

export interface SimAdapterOptions {
  cloud: SimCloud;
  /** Đường tra cứu mà adapter này KHAI. Bộ hợp đồng kiểm đúng đường đó hoạt động */
  lookupBy: "tag" | "deterministic-name";
  /** Nhãn credential mà `preflightPermissions` dùng để quyết định thiếu quyền hay không */
  credentialLabel?: string;
}

const ok = <T>(data: T): AdapterResult<T> => ({ status: "SUCCESS", data });
const failed = <T>(message: string): AdapterResult<T> => ({
  status: "FAILED",
  message,
});

/** `{projectId}:{step}:{kind}:{name}` — cùng hình với cột `idempotency_key` của sổ */
export const idempotencyKeyOf = (
  projectId: string,
  step: ProvisionStep,
  kind: CreatedResourceKind,
  name: string,
): string => `${projectId}:${step}:${kind}:${name}`;

/** Phân tích ngược một `udp.key`. `null` nếu không đúng hình — KHÔNG đoán */
export function parseIdempotencyKey(key: string): {
  projectId: string;
  step: ProvisionStep;
  kind: CreatedResourceKind;
  name: string;
} | null {
  const parts = key.split(":");
  if (parts.length !== 4) return null;
  const [projectId, step, kind, name] = parts as [
    string,
    string,
    string,
    string,
  ];
  if (!["NETWORK", "CLUSTER", "DOMAINS", "K8S_MANAGED"].includes(step)) {
    return null;
  }
  return {
    projectId,
    step: step as ProvisionStep,
    kind: kind as CreatedResourceKind,
    name,
  };
}

export function createSimAdapter(options: SimAdapterOptions): CloudAdapter {
  const { cloud, lookupBy } = options;
  const label = options.credentialLabel ?? "du-quyen";

  const stepFor = (
    spec: (typeof FIXTURE_STEPS)[number],
    params: { projectId: string; tags: Record<string, string> },
  ): ResourceStep => {
    const key = idempotencyKeyOf(
      params.projectId,
      spec.step,
      spec.kind,
      spec.name,
    );
    /**
     * Một `kind` không gắn được tag lúc tạo BUỘC phải tra theo tên tất định, bất kể adapter
     * khai gì. Khai `"tag"` cho một API như thế là đúng thứ mà phép kiểm `lookupBy` của
     * §13.2 sinh ra để bắt — nên ở đây ta tôn trọng hiện thực, và để bộ hợp đồng phát hiện
     * nếu ai đó khai sai.
     */
    const mustUseName = KINDS_WITHOUT_CREATE_TAGS.includes(spec.kind);
    const effective = mustUseName ? "deterministic-name" : lookupBy;

    return {
      kind: spec.kind,
      name: spec.name,
      idempotencyKey: key,
      lookupBy: effective,

      lookup: (): Promise<LookupOutcome> => {
        const found =
          effective === "tag"
            ? (cloud.findByTag("udp.key", key)[0] ?? null)
            : cloud.findByName(spec.kind, spec.name);
        return Promise.resolve(
          found === null
            ? { kind: "absent" }
            : { kind: "found", resource: found },
        );
      },

      lookupById: (_cred, providerId): Promise<LookupOutcome> => {
        const r = cloud.describeById(providerId);
        return Promise.resolve(
          r === null ? { kind: "absent" } : { kind: "found", resource: r },
        );
      },

      create: (_cred, prior): Promise<CreatedResource> => {
        const parent =
          spec.dependsOn === undefined ? undefined : prior[spec.dependsOn];
        return Promise.resolve(
          cloud.createResource({
            kind: spec.kind,
            name: spec.name,
            /** Tag đi TRONG lời gọi tạo, không bằng một lời gọi `tagResource` riêng */
            tags: { ...params.tags, "udp.key": key },
            idempotencyKey: key,
            ...(parent === undefined ? {} : { attachedTo: parent.id }),
          }),
        );
      },

      waitReady: (_cred, r): Promise<void> => {
        if (!cloud.pollReady(r.id)) throw new Error(`${r.id} chưa READY`);
        return Promise.resolve();
      },

      delete: (_cred, r): Promise<void> => {
        cloud.deleteResource(r.id);
        return Promise.resolve();
      },
    };
  };

  return {
    providerId: "aws",

    validateCredential: (credential) =>
      Promise.resolve(
        credential.expiresAt.getTime() > Date.now()
          ? ok({ valid: true })
          : ok({ valid: false, reason: "credential đã hết hạn" }),
      ),

    /**
     * `confidence` khai `heuristic`, không `exact`.
     *
     * Cloud mô phỏng không có API mô phỏng quyền như `iam:SimulatePrincipalPolicy`, nên khai
     * `exact` là nói quá — và §13.2 có một phép kiểm riêng cho đúng việc đó: "adapter khai
     * `exact` mà thực chất đoán là fail". Phân biệt hai mức này là để trung thực, không phải
     * để trang trí.
     */
    preflightPermissions: () => {
      const missing = cloud.missingPermissionsFor(label);
      const report: PreflightReport = {
        ok: missing.length === 0,
        confidence: "heuristic",
        missingPermissions: missing,
        quotaWarnings: [],
        docUrl: "https://udp.example/docs/byoc-iam",
      };
      return Promise.resolve(ok(report));
    },

    estimateCost: (params) => {
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
      const perNode = { small: 15, medium: 30, large: 60 }[params.nodeSize];
      const breakdown = [
        { item: "control-plane", monthlyUsd: 73 },
        { item: "nat-gateway", monthlyUsd: 32 },
        { item: "load-balancer", monthlyUsd: 18 },
        { item: "nodes", monthlyUsd: perNode * params.nodeCount },
      ];
      return Promise.resolve(
        ok<CostEstimate>({
          monthlyUsd: breakdown.reduce((a, b) => a + b.monthlyUsd, 0),
          breakdown,
          isEstimate: true,
          pricingAsOf: "2026-09-01",
        }),
      );
    },

    networkSteps: (params: ProvisionNetworkParams): ResourceStep[] =>
      FIXTURE_STEPS.filter((s) => s.step === "NETWORK").map((s) =>
        stepFor(s, { projectId: params.projectId, tags: params.tags }),
      ),

    clusterSteps: (
      params: ProvisionClusterParams,
      _network: NetworkInfo,
    ): ResourceStep[] =>
      FIXTURE_STEPS.filter((s) => s.step === "CLUSTER").map((s) =>
        stepFor(s, { projectId: params.projectId, tags: params.tags }),
      ),

    getClusterStatus: (_cred, clusterId) => {
      const status = cloud.clusterStatusOf(clusterId);
      if (status === "ERROR") {
        return Promise.resolve(failed<ClusterInfo>(`không thấy ${clusterId}`));
      }
      return Promise.resolve(
        ok<ClusterInfo>({
          clusterId,
          clusterName: clusterId,
          apiEndpoint: `https://${clusterId}.sim.invalid`,
          caData: "c2ltLWNh",
          status,
          controlPlaneServiceAccounts: {
            workload: "udp-system/udp-workload",
            traffic: "udp-system/udp-traffic",
            tooling: "udp-system/udp-tooling",
          },
        }),
      );
    },

    getKubeAuthToken: (_cred, cluster) =>
      Promise.resolve(ok(cloud.kubeTokenFor(cluster.clusterId))),

    /**
     * Đi HẾT phân trang.
     *
     * Trang cỡ 2 của cloud mô phỏng có chủ đích: một hiện thực chỉ đọc trang đầu vẫn "thành
     * công" nhưng trả về một danh sách thiếu, và `rebuildLedgerFromCloud` dựng lại một sổ
     * thiếu — mà nó vẫn báo SUCCESS.
     */
    listTaggedResources: (_cred, projectId) => {
      const out: CreatedResource[] = [];
      let cursor: string | undefined;
      let guard = 0;
      do {
        const page = cloud.listTaggedPage(projectId, cursor);
        out.push(...page.items);
        cursor = page.next;
        guard += 1;
      } while (cursor !== undefined && guard < 1000);
      return Promise.resolve(ok(out));
    },

    /**
     * Dựng lại sổ CHỈ từ tag.
     *
     * Không đọc sổ, không đọc database, không dùng một map nào sống trong adapter. Mọi cột
     * suy từ `udp.key` cộng thuộc tính của chính tài nguyên — trừ `job_id`, thứ ADR-08 nói
     * không suy ra được, nên `ProvisionedResourceRow` không có nó.
     *
     * Tài nguyên mang `udp.project` đúng mà `udp.key` không đúng hình, hoặc `udp.managed`
     * khác `"true"`, đi vào `unmatched` — KHÔNG bị đoán thành một hàng sổ.
     */
    rebuildLedgerFromCloud: (_cred, projectId) => {
      const out: ProvisionedResourceRow[] = [];
      const unmatched: CreatedResource[] = [];
      let cursor: string | undefined;
      let guard = 0;

      do {
        const page = cloud.listTaggedPage(projectId, cursor);
        for (const r of page.items) {
          const key = r.tags["udp.key"];
          const managed = r.tags["udp.managed"];
          const parsed = key === undefined ? null : parseIdempotencyKey(key);
          if (
            parsed === null ||
            managed !== "true" ||
            parsed.projectId !== projectId
          ) {
            unmatched.push(r);
            continue;
          }
          out.push({
            projectId,
            step: parsed.step,
            kind: r.kind,
            idempotencyKey: key as string,
            providerId: r.id,
            provider: r.provider,
            region: r.region,
            /**
             * Tài nguyên tồn tại trên cloud và tra lại được, nên trạng thái dựng lại là
             * `READY`. Sổ là cache: nó không cần biết lịch sử, nó cần khớp hiện tại.
             */
            status: "READY",
          });
        }
        cursor = page.next;
        guard += 1;
      } while (cursor !== undefined && guard < 1000);

      /**
       * [v4.10] Đường thứ HAI: dò theo TÊN TẤT ĐỊNH.
       *
       * Một `kind` mà API không cho gắn tag lúc tạo (§4.5 quy tắc 2) **không xuất hiện**
       * trong `listTaggedResources` — nó không mang tag nào. Nên quét tag một mình bỏ sót
       * đúng những `kind` đó, và bỏ sót IM LẶNG: hàm vẫn trả `SUCCESS` với một sổ thiếu.
       *
       * Adapter biết lược đồ tên của chính nó, nên nó dò được. Hai đường độc lập, cùng cấu
       * trúc với `lookup`/`lookupById` — hỏng một vẫn còn một.
       */
      const seen = new Set(out.map((r) => r.providerId));
      for (const spec of FIXTURE_STEPS) {
        if (!KINDS_WITHOUT_CREATE_TAGS.includes(spec.kind)) continue;
        const found = cloud.findByName(spec.kind, spec.name);
        if (found === null || seen.has(found.id)) continue;
        out.push({
          projectId,
          step: spec.step,
          kind: spec.kind,
          idempotencyKey: idempotencyKeyOf(
            projectId,
            spec.step,
            spec.kind,
            spec.name,
          ),
          providerId: found.id,
          provider: found.provider,
          region: found.region,
          status: "READY",
        });
      }

      return Promise.resolve(ok({ rows: out, unmatched }));
    },

    teardown: async (_cred, resources) => {
      const outcome = await runTeardown({
        resources,
        cloud: {
          deleteResource: (r) => Promise.resolve(cloud.deleteResource(r.id)),
          describeById: (id) => Promise.resolve(cloud.describeById(id)),
        },
        waitTimeoutMs: 2_000,
        pollIntervalMs: 1,
        now: () => Date.now(),
        sleep: () => Promise.resolve(),
      });
      return ok({
        deleted: [...outcome.deleted],
        failed: outcome.orphans.map((o) => o.resource.id),
      });
    },
  };
}

/** Tag mà một lần provision của adapter sim gắn, cho một project cụ thể */
export function simTags(args: {
  projectId: string;
  owner: string;
  expiresAt?: string;
}): Record<string, string> {
  const base: Record<string, string> = {
    "udp.project": args.projectId,
    "udp.owner": args.owner,
    "udp.managed": "true",
  };
  if (args.expiresAt !== undefined) base["udp.ttl"] = args.expiresAt;
  /** Khớp đúng tập khoá mong đợi, trừ `udp.key` do từng step tự gắn */
  void expectedTagKeys(args.expiresAt !== undefined);
  return base;
}
