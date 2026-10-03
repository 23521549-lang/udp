import type {
  CostEstimate,
  CreatedResourceKind,
  ResourceQuota,
} from "./cloud.js";
import type { ProvisionedResourceRow } from "./ledger.js";

/**
 * [v4.10] Bốn lớp bảo vệ chi phí của §4.4, dưới dạng HÀM THUẦN.
 *
 * Trong mô hình BYOC, một lỗi lập trình của UDP tiêu tiền thật trong tài khoản của
 * developer. Đó là lý do bốn lớp này không phải tính năng mà là *guardrail*, và là lý do
 * chúng được viết thuần: một quyết định tiêu tiền phải kiểm được mà không cần dựng cloud,
 * không cần database, và không cần chờ một cron chạy.
 *
 * | Lớp | Ở đây | Chặn được gì |
 * | --- | --- | --- |
 * | 1. Quota | `quotaViolations` | vòng lặp provisioning, người dùng nhập `nodeCount = 1000` |
 * | 2. Ước tính trước | `validateCostEstimate` | bất ngờ về hoá đơn — ba mục hay bị bỏ sót nhất |
 * | 3. TTL | `expiryDecision` | cluster demo bị quên, mà KHÔNG xoá nhầm production của khách |
 * | 4. Sổ + tag + quét | `classifyOrphans` | tài nguyên còn sót sau khi job chết |
 *
 * Lớp 3 là lớp dễ làm sai nhất và sai thì tốn nhất: bản v3 để cron tự xoá mọi project quá
 * hạn, và xoá nhầm cluster production trong tài khoản người khác là rủi ro pháp lý chứ
 * không phải một bug.
 */

// ===================================================================== lớp 1

/** Một chiều quota bị vượt */
export interface QuotaViolation {
  dimension: keyof ResourceQuota;
  planned: number | string;
  limit: number | string;
}

const NODE_SIZE_ORDER: readonly ResourceQuota["maxNodeSize"][] = [
  "small",
  "medium",
  "large",
];

/**
 * Kế hoạch mà một lần provision khai TRƯỚC khi gọi cloud.
 *
 * Mọi trường optional: một kế hoạch chỉ dựng network không khai `nodes`, và khi đó chiều
 * đó không được kiểm — chứ không phải được coi là 0. Phân biệt hai điều đó là phân biệt
 * "không xin" với "xin 0".
 */
export interface PlannedUsage {
  nodes?: number;
  nodeSize?: ResourceQuota["maxNodeSize"];
  databases?: number;
  storageGb?: number;
  /**
   * LB mà CHÍNH adapter tạo.
   *
   * Đếm cả LB do domain adapter hay ứng dụng sinh ra cần một admission webhook trong
   * cluster, thứ nằm ngoài phạm vi plan này — xem sổ nợ `quota-lb-webhook`. Phát biểu
   * trung thực của lớp 1 vì vậy là: adapter cưỡng chế phần nó tạo, và phần còn lại là
   * một giới hạn đã ghi ở §16.
   */
  loadBalancers?: number;
}

/** Mọi chiều bị vượt. Rỗng nghĩa là qua — kiểm TRƯỚC mọi lời gọi cloud (§4.4 lớp 1) */
export function quotaViolations(
  planned: PlannedUsage,
  quota: ResourceQuota,
): QuotaViolation[] {
  const out: QuotaViolation[] = [];

  if (planned.nodes !== undefined && planned.nodes > quota.maxNodes) {
    out.push({
      dimension: "maxNodes",
      planned: planned.nodes,
      limit: quota.maxNodes,
    });
  }
  if (planned.nodeSize !== undefined) {
    const want = NODE_SIZE_ORDER.indexOf(planned.nodeSize);
    const cap = NODE_SIZE_ORDER.indexOf(quota.maxNodeSize);
    if (want > cap) {
      out.push({
        dimension: "maxNodeSize",
        planned: planned.nodeSize,
        limit: quota.maxNodeSize,
      });
    }
  }
  if (
    planned.databases !== undefined &&
    planned.databases > quota.maxDatabases
  ) {
    out.push({
      dimension: "maxDatabases",
      planned: planned.databases,
      limit: quota.maxDatabases,
    });
  }
  if (
    planned.storageGb !== undefined &&
    planned.storageGb > quota.maxStorageGb
  ) {
    out.push({
      dimension: "maxStorageGb",
      planned: planned.storageGb,
      limit: quota.maxStorageGb,
    });
  }
  if (
    planned.loadBalancers !== undefined &&
    planned.loadBalancers > quota.maxLoadBalancers
  ) {
    out.push({
      dimension: "maxLoadBalancers",
      planned: planned.loadBalancers,
      limit: quota.maxLoadBalancers,
    });
  }

  return out;
}

// ===================================================================== lớp 2

/**
 * Ba mục mà `estimateCost` BẮT BUỘC phải liệt kê.
 *
 * §4.4 gọi chúng là "nguyên nhân số một" của bất ngờ về hoá đơn, và lý do rất cụ thể: cả
 * ba đều tính tiền theo GIỜ bất kể có ai dùng hay không. Control plane của EKS/GKE khoảng
 * 0,10 USD/giờ; một NAT gateway khoảng 32 USD/tháng cộng phí dữ liệu; một load balancer
 * tương tự. Một bản ước tính chỉ liệt kê node sẽ thấp hơn hoá đơn thật nhiều lần.
 */
export const MANDATORY_COST_ITEMS: readonly string[] = [
  "control-plane",
  "nat-gateway",
  "load-balancer",
];

/** Bảng giá tĩnh phải khai ngày, và ngày đó không được cũ quá mức này */
export const PRICING_MAX_AGE_DAYS = 400;

export interface CostEstimateProblem {
  code:
    | "MISSING_ITEM"
    | "TOTAL_MISMATCH"
    | "PRICING_AS_OF_INVALID"
    | "PRICING_TOO_OLD"
    | "NEGATIVE_AMOUNT";
  detail: string;
}

/**
 * Kiểm một `CostEstimate` có trung thực hay không.
 *
 * `TOTAL_MISMATCH` là phép kiểm quan trọng nhất: một bản ước tính mà tổng KHÔNG bằng tổng
 * các mục là một bản ước tính mà người ta đã sửa con số tổng bằng tay, và khi đó ba mục
 * bắt buộc ở trên chỉ còn là trang trí.
 */
export function validateCostEstimate(
  estimate: CostEstimate,
  now: Date = new Date(),
): CostEstimateProblem[] {
  const problems: CostEstimateProblem[] = [];
  const items = new Set(estimate.breakdown.map((b) => b.item));

  for (const required of MANDATORY_COST_ITEMS) {
    if (!items.has(required)) {
      problems.push({
        code: "MISSING_ITEM",
        detail: `thiếu mục bắt buộc "${required}"`,
      });
    }
  }

  const sum = estimate.breakdown.reduce((a, b) => a + b.monthlyUsd, 0);
  /** So với sai số một cent: tiền là số thập phân, và 0,1 + 0,2 !== 0,3 */
  if (Math.abs(sum - estimate.monthlyUsd) > 0.01) {
    problems.push({
      code: "TOTAL_MISMATCH",
      detail: `tổng khai ${String(estimate.monthlyUsd)} nhưng tổng các mục là ${String(sum)}`,
    });
  }

  if (estimate.breakdown.some((b) => b.monthlyUsd < 0)) {
    problems.push({
      code: "NEGATIVE_AMOUNT",
      detail: "có mục mang số âm",
    });
  }

  const asOf = new Date(estimate.pricingAsOf);
  if (Number.isNaN(asOf.getTime())) {
    problems.push({
      code: "PRICING_AS_OF_INVALID",
      detail: `pricingAsOf không phân tích được: ${estimate.pricingAsOf}`,
    });
  } else {
    const ageDays = (now.getTime() - asOf.getTime()) / 86_400_000;
    if (ageDays > PRICING_MAX_AGE_DAYS) {
      problems.push({
        code: "PRICING_TOO_OLD",
        detail: `bảng giá đã ${String(Math.round(ageDays))} ngày`,
      });
    }
  }

  return problems;
}

// ===================================================================== lớp 3

/** Ba mốc cảnh báo trước khi hết hạn, theo §4.4 lớp 3 */
export const EXPIRY_WARN_HOURS: readonly number[] = [72, 24, 1];

export interface ProjectExpiry {
  expiresAt: Date | null;
  expiryAction: "WARN" | "TEARDOWN";
  /** Có environment `is_production` đã deploy hay không */
  hasDeployedProductionEnv: boolean;
}

export type ExpiryDecision =
  | { kind: "none" }
  /** Cảnh báo owner, KHÔNG chạm tài nguyên */
  | { kind: "warn"; hoursLeft: number; threshold: number }
  /** Đã quá hạn nhưng `expiry_action = WARN`: đánh dấu EXPIRED trên Portal, không xoá */
  | { kind: "expired-warn-only" }
  /** Được phép dọn. Người gọi PHẢI ghi `AuditLog(SYSTEM)` TRƯỚC khi xoá */
  | { kind: "teardown" }
  /** Quá hạn và `expiry_action = TEARDOWN`, nhưng bị chặn có lý do */
  | { kind: "teardown-blocked"; reason: string };

/**
 * Quyết định TTL — thuần, và cố tình KHÔNG xoá gì.
 *
 * Bản v3 để cron tự xoá mọi project quá hạn. §4.4 gọi đó là rủi ro pháp lý chứ không phải
 * một bug: xoá nhầm cluster production trong tài khoản người khác không sửa được bằng một
 * bản vá. v4 vì vậy chia hai:
 *
 * - `WARN` là **mặc định của BYOC**: cảnh báo ở 72h/24h/1h, đánh dấu `EXPIRED` trên
 *   Portal, và **không đụng tài nguyên**.
 * - `TEARDOWN` chỉ được khi owner tự chọn **và** project không có environment
 *   `is_production` đã deploy.
 *
 * Hàm này trả về QUYẾT ĐỊNH, không thực hiện nó. Người gọi ghi `AuditLog(actor_type =
 * SYSTEM)` **trước** khi xoá — thứ tự đó là hợp đồng, vì một lần xoá không có vết là một
 * lần xoá không ai giải thích được.
 */
export function expiryDecision(
  project: ProjectExpiry,
  now: Date,
): ExpiryDecision {
  if (project.expiresAt === null) return { kind: "none" };

  const msLeft = project.expiresAt.getTime() - now.getTime();
  const hoursLeft = msLeft / 3_600_000;

  if (hoursLeft > 0) {
    /** Mốc NHỎ NHẤT còn chứa `hoursLeft`: gần hết hạn thì cảnh báo gấp hơn */
    const threshold = [...EXPIRY_WARN_HOURS]
      .sort((a, b) => a - b)
      .find((h) => hoursLeft <= h);
    return threshold === undefined
      ? { kind: "none" }
      : { kind: "warn", hoursLeft, threshold };
  }

  if (project.expiryAction === "WARN") return { kind: "expired-warn-only" };

  if (project.hasDeployedProductionEnv) {
    return {
      kind: "teardown-blocked",
      reason:
        "project có environment is_production đã deploy: TEARDOWN tự động bị chặn, " +
        "chủ project phải xác nhận bằng tay",
    };
  }

  return { kind: "teardown" };
}

// ===================================================================== lớp 4

/**
 * Giá theo GIỜ của những `kind` tính tiền kể cả khi không ai dùng.
 *
 * `null` nghĩa là **không định giá được**, và đó là một giá trị khác hẳn `0`. Trả `0` cho
 * một tài nguyên ta không biết giá là che chi phí — đúng thứ mà lớp 4 tồn tại để chống.
 */
export const ORPHAN_HOURLY_USD: Readonly<
  Partial<Record<CreatedResourceKind, number>>
> = {
  "nat-gateway": 0.045,
  "elastic-ip": 0.005,
  cluster: 0.1,
  "k8s-loadbalancer": 0.0225,
  "k8s-volume": 0.00014,
  nodegroup: 0.0416,
};

/** Ngày của bảng giá trên */
export const ORPHAN_PRICING_AS_OF = "2026-09-01";

export interface OrphanReport {
  /** Hàng sổ đang ở `ORPHAN_SUSPECTED` */
  suspected: readonly ProvisionedResourceRow[];
  /** Tổng USD/giờ của những hàng định giá được */
  estimatedUsdPerHour: number;
  /** Hàng không định giá được — nêu ra, KHÔNG tính là 0 */
  unpriced: readonly CreatedResourceKind[];
  /** Tài nguyên mang `udp.project` đúng mà KHÔNG có hàng trong sổ */
  unmatchedOnCloud: readonly string[];
  pricingAsOf: string;
}

/**
 * Phân loại tài nguyên mồ côi, kèm chi phí đang chạy.
 *
 * `GET /admin/orphan-resources` hiển thị kết quả này, và §4.5 nói rõ `ORPHAN_SUSPECTED`
 * **không phải một trạng thái cuối im lặng**. Con số USD/giờ là thứ biến "có vài tài
 * nguyên còn sót" thành "đang mất 2,4 USD mỗi ngày", và chỉ con số thứ hai làm người ta
 * hành động.
 */
export function classifyOrphans(args: {
  ledgerRows: readonly ProvisionedResourceRow[];
  /** id của mọi tài nguyên trên cloud mang `udp.project` của project này */
  cloudIdsWithProjectTag: readonly string[];
}): OrphanReport {
  const suspected = args.ledgerRows.filter(
    (r) => r.status === "ORPHAN_SUSPECTED",
  );

  let total = 0;
  const unpriced: CreatedResourceKind[] = [];
  for (const row of suspected) {
    const hourly = ORPHAN_HOURLY_USD[row.kind];
    if (hourly === undefined) unpriced.push(row.kind);
    else total += hourly;
  }

  const knownIds = new Set(
    args.ledgerRows
      .map((r) => r.providerId)
      .filter((id): id is string => id !== null),
  );
  const unmatchedOnCloud = args.cloudIdsWithProjectTag.filter(
    (id) => !knownIds.has(id),
  );

  return {
    suspected,
    /** Làm tròn tới 4 chữ số: tiền không cần độ chính xác của số thực */
    estimatedUsdPerHour: Math.round(total * 10_000) / 10_000,
    unpriced: [...new Set(unpriced)],
    unmatchedOnCloud,
    pricingAsOf: ORPHAN_PRICING_AS_OF,
  };
}
