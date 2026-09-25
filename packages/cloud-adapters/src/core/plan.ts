import type {
  CloudProvider,
  CreatedResourceKind,
  NetworkInfo,
  ProvisionClusterParams,
  ProvisionNetworkParams,
} from "@udp/adapter-core";

/**
 * Phần THUẦN, riêng của từng cloud (Plan #26 QĐ-2): step nào, theo thứ tự nào, tham số gì,
 * tag mã hoá ra sao, cần quyền gì, giá bao nhiêu. Không gọi mạng — nên test được hết bằng
 * dữ liệu, và bộ hợp đồng chạy được trên chính kế hoạch này.
 */

/** Ngữ cảnh dựng tham số của một step — đúng thứ `networkSteps`/`clusterSteps` nhận */
export type StepContext =
  | { phase: "NETWORK"; params: ProvisionNetworkParams }
  | { phase: "CLUSTER"; params: ProvisionClusterParams; network: NetworkInfo };

export interface StepSpec {
  /**
   * Tên logic, nằm trong khoá idempotency. Bộ hợp đồng Cloud gọi step mạng gốc là `vpc`
   * (`created["vpc"]`), nên mọi kế hoạch đặt đúng tên đó cho mạng gốc của mình.
   */
  name: string;
  kind: CreatedResourceKind;
  phase: "NETWORK" | "CLUSTER";
  /** Tên logic của các step ĐỨNG TRƯỚC mà `create` đọc từ `prior` (§4.2 hợp đồng `prior`) */
  dependsOn: readonly string[];
  /** Tham số gửi cho cổng — kiểu riêng của cloud, lõi không đọc */
  build(ctx: StepContext): unknown;
}

/**
 * Mã hoá tag dạng CHUẨN (`udp.project`, …) sang dạng cloud cho phép và ngược lại
 * (Plan #26 QĐ-4). `problems` liệt kê mọi vi phạm luật của cloud — cổng từ chối gửi
 * một bộ tag có vấn đề thay vì để cloud trả 400 giữa chừng provisioning.
 */
export interface TagCodec {
  encode(tags: Readonly<Record<string, string>>): Record<string, string>;
  decode(raw: Readonly<Record<string, string>>): Record<string, string>;
  problems(raw: Readonly<Record<string, string>>): string[];
}

export interface PricingTable {
  /** Ngày của bảng giá tĩnh (§4.2 `CostEstimate.pricingAsOf`) */
  asOf: string;
  controlPlaneMonthlyUsd: number;
  natGatewayMonthlyUsd: number;
  loadBalancerMonthlyUsd: number;
  nodeMonthlyUsd: Readonly<Record<"small" | "medium" | "large", number>>;
}

export interface ProviderPlan {
  provider: CloudProvider;
  networkSteps: readonly StepSpec[];
  clusterSteps: readonly StepSpec[];
  /** Kind mà API không cho gắn tag lúc tạo ⇒ tra theo tên tất định (§4.5 quy tắc 2) */
  kindsWithoutCreateTags: readonly CreatedResourceKind[];
  /** Tên vật lý tất định theo project — đường tra cứu dự phòng khi tag mất */
  physicalName(projectId: string, stepName: string): string;
  requiredPermissions: readonly string[];
  pricing: PricingTable;
  /** Trust policy / IAM policy mẫu cho khách (§4.3) */
  docUrl: string;
}

/** Ba ServiceAccount rời nhau trong cluster của khách (§12.2) — giống nhau ở cả ba cloud */
export const CONTROL_PLANE_SERVICE_ACCOUNTS = {
  workload: "udp-system/udp-workload",
  traffic: "udp-system/udp-traffic",
  tooling: "udp-system/udp-tooling",
} as const;

/** Kế hoạch hợp lệ: tên step duy nhất, `dependsOn` chỉ trỏ lùi, có `vpc` và một `cluster` */
export function planProblems(plan: ProviderPlan): string[] {
  const out: string[] = [];
  const steps = [...plan.networkSteps, ...plan.clusterSteps];
  const seen = new Set<string>();
  for (const s of steps) {
    if (seen.has(s.name)) out.push(`tên step trùng: ${s.name}`);
    for (const d of s.dependsOn) {
      if (!seen.has(d)) out.push(`${s.name} phụ thuộc ${d} chưa đứng trước`);
    }
    seen.add(s.name);
  }
  if (!plan.networkSteps.some((s) => s.name === "vpc" && s.kind === "vpc")) {
    out.push("thiếu step mạng gốc tên `vpc`");
  }
  if (!plan.clusterSteps.some((s) => s.kind === "cluster")) {
    out.push("thiếu step kind=cluster");
  }
  return out;
}
