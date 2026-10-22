import type { CreatedResource, CreatedResourceKind } from "./cloud.js";
import { TEARDOWN_ORDER } from "./cloud.js";
import { ORPHAN_HOURLY_USD } from "./guardrails.js";

/**
 * [v4.10] Teardown theo THỨ TỰ, ở mã sản phẩm (§4.2, §4.5).
 *
 * Đây là chỗ mà §4.5 gọi là "chỗ mọi state file đều mù". Một `Service` kiểu `LoadBalancer`
 * làm cloud-controller-manager tạo ELB và ENI; một `PersistentVolumeClaim` tạo EBS. Adapter
 * không gọi API nào để tạo chúng, nên:
 *
 *  - **Không state file nào biết chúng tồn tại.** Terraform quản lý cluster nhưng không quản
 *    lý thứ mà workload chạy trong cluster sinh ra.
 *  - Chúng **giữ tham chiếu tới VPC**, nên `DeleteVpc` thất bại với `DependencyViolation`
 *    — và thất bại **vĩnh viễn**, vì không có gì tự dọn chúng sau khi cluster bị xoá.
 *  - Hậu quả trong mô hình BYOC: NAT gateway và load balancer tiếp tục tính tiền trong tài
 *    khoản của khách sau khi họ tưởng đã xoá project.
 *
 * Ba tính chất mà mã dưới đây cưỡng chế, và cả ba đều là chỗ một hiện thực hợp lý vẫn sai:
 *
 *  1. **Thứ tự chín bậc là dữ liệu**, đối chiếu với `TEARDOWN_ORDER` — không phải một chuỗi
 *     lời gọi viết tay mà người ta đổi thứ tự lúc refactor.
 *  2. **`waitGone` hết hạn là `ORPHAN_SUSPECTED` kèm chi phí**, KHÔNG phải thành công. Nuốt
 *     timeout là chế độ hỏng tệ nhất của cả mục: nó báo "đã dọn xong" trong khi hoá đơn vẫn
 *     chạy.
 *  3. **Mọi `kind` phải có bậc.** Một `kind` chưa được xếp bậc sẽ bị xoá ở đâu đó không xác
 *     định, và nếu nó giữ tham chiếu VPC thì bậc `vpc` vỡ.
 */

/** Bậc nào xoá `kind` nào. Rào `wait-k8s-gone` không có `kind` — nó là một mốc chờ */
const TIER_OF_KIND: Readonly<Record<CreatedResourceKind, string>> = {
  "k8s-loadbalancer": "k8s-managed",
  "k8s-volume": "k8s-managed",
  "k8s-eni": "k8s-managed",

  addon: "addon",
  nodegroup: "nodegroup",

  cluster: "cluster",
  "controlplane-sa": "cluster",

  "oidc-provider": "oidc-iam",
  "iam-role": "oidc-iam",
  "iam-policy": "oidc-iam",
  "service-account": "oidc-iam",
  "managed-identity": "oidc-iam",

  "nat-gateway": "nat",
  "elastic-ip": "nat",

  subnet: "subnet-route",
  "route-table": "subnet-route",
  "internet-gateway": "subnet-route",
  "security-group": "subnet-route",
  "firewall-rule": "subnet-route",
  nsg: "subnet-route",
  "cloud-router": "subnet-route",

  vpc: "vpc",
};

/**
 * Bậc mà một `kind` thuộc về.
 *
 * Tính đầy đủ được cưỡng chế ở **hai** tầng, và tầng thứ nhất mạnh hơn:
 *
 *  1. `TIER_OF_KIND` khai kiểu `Record<CreatedResourceKind, string>` — một `Record` TOÀN
 *     PHẦN. Thêm một `kind` vào union mà quên xếp bậc là một **lỗi biên dịch**, không phải
 *     một lỗi lúc chạy. Đó là lý do không có phép kiểm `=== undefined` ở đây: trình biên
 *     dịch đã biết nó không xảy ra được, và một phép kiểm mã chết làm người đọc tưởng
 *     bảo đảm nằm ở chỗ khác.
 *  2. `Object.hasOwn` bắt trường hợp một giá trị lạ lọt vào lúc chạy qua một phép ép kiểu.
 *     Nó ném thay vì trả `undefined`: một `kind` không có bậc sẽ bị xoá ở một thứ tự không
 *     xác định, và nếu nó giữ tham chiếu VPC thì bậc cuối vỡ.
 */
export function teardownTierOf(kind: CreatedResourceKind): string {
  if (!Object.hasOwn(TIER_OF_KIND, kind)) {
    throw new Error(
      `kind "${kind}" chưa được xếp bậc teardown: nó sẽ bị xoá ở một thứ tự không xác định`,
    );
  }
  return TIER_OF_KIND[kind];
}

/** Mọi kind đã xếp bậc — cho test đối chiếu tính đầy đủ */
export const TEARDOWN_TIER_OF_KIND = TIER_OF_KIND;

export interface TeardownBatch {
  tier: string;
  resources: readonly CreatedResource[];
}

/**
 * Chia tài nguyên thành các lô theo đúng thứ tự chín bậc.
 *
 * Bậc không có tài nguyên nào thì **vẫn xuất hiện** nếu nó là rào `wait-k8s-gone`, vì rào
 * đó phải chạy dù có tài nguyên `k8s-*` hay không: một tài nguyên do Kubernetes sinh có thể
 * tồn tại trên cloud mà sổ chưa biết, và đó chính là ca `listTaggedResources` tồn tại để
 * phát hiện.
 */
export function teardownBatches(
  resources: readonly CreatedResource[],
): TeardownBatch[] {
  const byTier = new Map<string, CreatedResource[]>();
  for (const r of resources) {
    const tier = teardownTierOf(r.kind);
    const list = byTier.get(tier) ?? [];
    list.push(r);
    byTier.set(tier, list);
  }

  const out: TeardownBatch[] = [];
  for (const tier of TEARDOWN_ORDER) {
    const list = byTier.get(tier);
    if (tier === "wait-k8s-gone") {
      out.push({ tier, resources: [] });
      continue;
    }
    if (list !== undefined && list.length > 0) {
      out.push({ tier, resources: list });
    }
  }
  return out;
}

/**
 * Tài nguyên do Kubernetes sinh, phát hiện từ tag.
 *
 * Cloud-controller-manager gắn `kubernetes.io/cluster/<tên>` lên ELB, ENI và EBS nó tạo.
 * Adapter không tạo chúng nên sổ không có hàng nào — `listTaggedResources()` là lưới an
 * toàn duy nhất, và trong SỔ chúng được ghi với `step = "K8S_MANAGED"` (không có cột
 * boolean nào cho việc đó, xem §2.2).
 */
export function discoverK8sManaged(
  cloudResources: readonly CreatedResource[],
  clusterName: string,
): CreatedResource[] {
  const tagKey = `kubernetes.io/cluster/${clusterName}`;
  return cloudResources.filter((r) => r.tags[tagKey] !== undefined);
}

/** Cổng hẹp mà teardown cần — hẹp để test dựng được bằng cloud mô phỏng */
export interface TeardownCloud {
  deleteResource(r: CreatedResource): Promise<"deleted" | "not-found">;
  describeById(id: string): Promise<CreatedResource | null>;
}

export interface WaitGoneResult {
  gone: readonly string[];
  /** Còn sót sau khi hết hạn — KHÔNG được coi là thành công */
  stillThere: readonly CreatedResource[];
  polls: number;
}

/**
 * Chờ một tập tài nguyên thật sự biến mất khỏi cloud.
 *
 * Hết hạn mà còn sót thì trả `stillThere` KHÔNG RỖNG, và người gọi phải đánh
 * `ORPHAN_SUSPECTED` kèm chi phí. Coi timeout là thành công là chế độ hỏng tệ nhất của cả
 * mục §4.5: nó báo "đã dọn xong" trong khi hoá đơn vẫn chạy, và không một test nào chỉ
 * kiểm đường thành công sẽ thấy.
 */
export async function waitGone(args: {
  resources: readonly CreatedResource[];
  cloud: TeardownCloud;
  timeoutMs: number;
  pollIntervalMs: number;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
}): Promise<WaitGoneResult> {
  const deadline = args.now() + args.timeoutMs;
  const gone = new Set<string>();
  let remaining = [...args.resources];
  let polls = 0;

  while (remaining.length > 0) {
    polls += 1;
    const next: CreatedResource[] = [];
    for (const r of remaining) {
      const still = await args.cloud.describeById(r.id);
      if (still === null) gone.add(r.id);
      else next.push(r);
    }
    remaining = next;
    if (remaining.length === 0) break;
    if (args.now() >= deadline) break;
    await args.sleep(args.pollIntervalMs);
  }

  return { gone: [...gone], stillThere: remaining, polls };
}

export interface TeardownOutcome {
  /** id đã xoá, theo đúng thứ tự đã gọi */
  deleted: readonly string[];
  /** Tài nguyên không dọn được, kèm lý do và chi phí đang chạy */
  orphans: readonly {
    resource: CreatedResource;
    reason: string;
    usdPerHour: number | null;
  }[];
  /** Bậc đã chạy, theo thứ tự — oracle của phép kiểm thứ tự */
  tiers: readonly string[];
  estimatedOrphanUsdPerHour: number;
}

/**
 * Chạy teardown theo thứ tự chín bậc.
 *
 * Rào `wait-k8s-gone` đứng NGAY SAU bậc `k8s-managed` và trước mọi bậc network: đó là toàn
 * bộ nội dung của mục này. Bỏ rào đó thì `DeleteVpc` ném `DependencyViolation` — và nếu ai
 * đó "sửa" bằng cách bắt lỗi rồi bỏ qua thì VPC, NAT gateway và load balancer sống mãi
 * trong tài khoản của khách.
 */
export async function runTeardown(args: {
  resources: readonly CreatedResource[];
  cloud: TeardownCloud;
  waitTimeoutMs: number;
  pollIntervalMs: number;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
}): Promise<TeardownOutcome> {
  const deleted: string[] = [];
  /** Mảng ghi được ở đây; `TeardownOutcome.orphans` là `readonly` với bên gọi */
  const orphans: {
    resource: CreatedResource;
    reason: string;
    usdPerHour: number | null;
  }[] = [];
  const tiers: string[] = [];
  const batches = teardownBatches(args.resources);
  const k8sBatch = batches.find((b) => b.tier === "k8s-managed");

  for (const batch of batches) {
    tiers.push(batch.tier);

    if (batch.tier === "wait-k8s-gone") {
      const toWaitFor = k8sBatch?.resources ?? [];
      if (toWaitFor.length === 0) continue;
      const result = await waitGone({
        resources: toWaitFor,
        cloud: args.cloud,
        timeoutMs: args.waitTimeoutMs,
        pollIntervalMs: args.pollIntervalMs,
        now: args.now,
        sleep: args.sleep,
      });
      for (const r of result.stillThere) {
        orphans.push({
          resource: r,
          reason:
            `còn tồn tại sau ${String(args.waitTimeoutMs)} ms chờ; ` +
            "xoá network bây giờ sẽ thất bại vĩnh viễn",
          usdPerHour: ORPHAN_HOURLY_USD[r.kind] ?? null,
        });
      }
      continue;
    }

    for (const r of batch.resources) {
      try {
        const outcome = await args.cloud.deleteResource(r);
        /** `NOT_FOUND` là THÀNH CÔNG: compensation chạy lại phải idempotent */
        deleted.push(r.id);
        void outcome;
      } catch (err) {
        orphans.push({
          resource: r,
          reason: `delete thất bại: ${describe(err)}`,
          usdPerHour: ORPHAN_HOURLY_USD[r.kind] ?? null,
        });
      }
    }
  }

  const priced = orphans
    .map((o) => o.usdPerHour)
    .filter((v): v is number => v !== null);

  return {
    deleted,
    orphans,
    tiers,
    estimatedOrphanUsdPerHour:
      Math.round(priced.reduce((a, b) => a + b, 0) * 10_000) / 10_000,
  };
}

function describe(err: unknown): string {
  if (err instanceof Error) {
    const code = (err as unknown as { code?: string }).code;
    return code === undefined ? err.message : `${code}: ${err.message}`;
  }
  return String(err);
}
