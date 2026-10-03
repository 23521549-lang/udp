import type {
  ArchitectureToolWire,
  WorkloadRedWire,
} from "@udp/shared-types/wire";

/**
 * [Plan #57 QĐ-2/QĐ-3] Mô hình của góc "Tổng quan hệ thống" — THUẦN, test được không cần DOM.
 *
 * Vị trí của một công cụ do VAI TRÒ của domain quyết định (bố cục C4 container cố định), không do dữ liệu: bật domain
 * nào là thấy nó ở đúng chỗ. Cạnh là vai trò suy từ domain đang bật, KHÔNG phải lưu lượng đo được; chữ của cạnh là
 * MÃ (`LinkKind`), câu nằm ở `system.messages.tsx` (I37). Quan hệ capability giữa công cụ (Cost đọc metrics của
 * Monitoring…) thuộc góc "Hạ tầng & công cụ": ở đây chúng chạy ngang qua thẻ khác cùng hàng.
 */

/** Vùng của sơ đồ: dải Giao hàng trên, Lưu lượng trái, Dữ liệu phải, dải Quan sát dưới, Quản trị phải dưới */
export type SystemZone = "delivery" | "traffic" | "data" | "observe" | "govern";

/** Mười sáu domain, mỗi domain đúng một vùng; thứ tự trong vùng là thứ tự trên sơ đồ */
export const SYSTEM_ZONES: Record<SystemZone, readonly string[]> = {
  delivery: [
    "CICD",
    "CONTAINER_REGISTRY",
    "ARTIFACT_REGISTRY",
    "GITOPS",
    "PROGRESSIVE_DELIVERY",
  ],
  traffic: ["INGRESS", "SERVICE_MESH"],
  data: ["DATABASE", "SECRETS"],
  observe: ["MONITORING", "LOGGING", "TRACING"],
  govern: ["POLICY", "SECURITY", "COST", "INFRA"],
};

/** Thành phần không phải công cụ: người dùng cuối, lần đẩy code, và khối các environment */
export const USERS = "users";
export const GIT = "git";
export const ENVS = "envs";

export type LinkKind =
  | "https"
  | "route"
  | "mtls"
  | "sql"
  | "secrets"
  | "metrics"
  | "logs"
  | "traces"
  | "webhook"
  | "push"
  | "publish"
  | "tag"
  | "sync"
  | "canary";

export interface SystemLink {
  from: string;
  to: string;
  kind: LinkKind;
  /** Nét liền: yêu cầu và dữ liệu; nét đứt: giao hàng, điều khiển, telemetry */
  dashed: boolean;
}

/**
 * Một chuỗi vai trò: `kinds[i]` là vai trò của cạnh RỜI `path[i]`. Mắt vắng mặt bị bỏ qua và cạnh nối thẳng tới mắt
 * kế tiếp đang có, mang vai trò của đầu đi (Ingress không có Service Mesh vẫn "định tuyến" vào environment).
 */
interface Chain {
  path: readonly string[];
  kinds: readonly LinkKind[];
  dashed: boolean;
}

const CHAINS: readonly Chain[] = [
  {
    path: [USERS, "INGRESS", "SERVICE_MESH", ENVS],
    kinds: ["https", "route", "mtls"],
    dashed: false,
  },
  {
    path: [
      GIT,
      "CICD",
      "CONTAINER_REGISTRY",
      "GITOPS",
      "PROGRESSIVE_DELIVERY",
      ENVS,
    ],
    kinds: ["webhook", "push", "tag", "sync", "canary"],
    dashed: true,
  },
];

/** Cạnh đơn: chỉ vẽ khi CẢ HAI đầu có mặt */
const SINGLES: readonly SystemLink[] = [
  { from: "CICD", to: "ARTIFACT_REGISTRY", kind: "publish", dashed: true },
  { from: ENVS, to: "DATABASE", kind: "sql", dashed: false },
  { from: ENVS, to: "SECRETS", kind: "secrets", dashed: true },
  { from: ENVS, to: "MONITORING", kind: "metrics", dashed: true },
  { from: ENVS, to: "LOGGING", kind: "logs", dashed: true },
  { from: ENVS, to: "TRACING", kind: "traces", dashed: true },
];

/** Cạnh vai trò giữa những thành phần CÓ MẶT (`USERS`, `GIT`, `ENVS` và domainType của công cụ đang bật) */
export function systemLinks(present: ReadonlySet<string>): SystemLink[] {
  const out: SystemLink[] = [];
  for (const chain of CHAINS) {
    const stops = chain.path.flatMap((id, i) =>
      present.has(id) ? [{ id, kind: chain.kinds[i] }] : [],
    );
    for (let i = 0; i + 1 < stops.length; i += 1) {
      const from = stops[i];
      const to = stops[i + 1];
      if (from?.kind === undefined || to === undefined) continue;
      out.push({
        from: from.id,
        to: to.id,
        kind: from.kind,
        dashed: chain.dashed,
      });
    }
  }
  for (const link of SINGLES) {
    if (present.has(link.from) && present.has(link.to)) out.push(link);
  }
  return out;
}

/** Công cụ đang bật của một vùng, theo thứ tự của vùng */
export function zoneTools(
  tools: readonly ArchitectureToolWire[],
  zone: SystemZone,
): ArchitectureToolWire[] {
  const byDomain = new Map(tools.map((t) => [t.domainType, t]));
  return SYSTEM_ZONES[zone].flatMap((d) => {
    const tool = byDomain.get(d);
    return tool === undefined ? [] : [tool];
  });
}

/** Điểm cuối CÓ dữ liệu của một chuỗi — `null` là "không có dữ liệu" (I7), khác 0 */
function lastValue(series: readonly (number | null)[]): number | null {
  for (let i = series.length - 1; i >= 0; i -= 1) {
    const v = series[i];
    if (v !== null && v !== undefined) return v;
  }
  return null;
}

/**
 * RED của một environment ở thời điểm gần nhất có dữ liệu: request/s cộng qua workload, tỉ lệ lỗi theo trọng số
 * request (workload ít request không kéo lệch cả env), p99 lấy workload chậm nhất — p99 không cộng hay lấy trung
 * bình được.
 */
export function redSummary(workloads: readonly WorkloadRedWire[]): {
  requestRate: number | null;
  errorRatio: number | null;
  latencyP99Ms: number | null;
} {
  let rate: number | null = null;
  let errors = 0;
  let weighted = 0;
  let p99: number | null = null;
  for (const w of workloads) {
    const r = lastValue(w.requestRate);
    const e = lastValue(w.errorRatio);
    const l = lastValue(w.latencyP99Ms);
    if (r !== null) {
      rate = (rate ?? 0) + r;
      if (e !== null) {
        errors += e * r;
        weighted += r;
      }
    }
    if (l !== null) p99 = Math.max(p99 ?? l, l);
  }
  return {
    requestRate: rate,
    errorRatio: weighted === 0 ? null : errors / weighted,
    latencyP99Ms: p99,
  };
}
