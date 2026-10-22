import type { ControlPlaneIdentity } from "@udp/adapter-core";
import { BOUND_TOKEN_SECONDS } from "@udp/cluster-access";

/**
 * Token cluster cấp cho Service 3 (ADR-06, §9 Internal) [Plan #51 QĐ-2] — hình và luật của route
 * `POST /internal/clusters/:id/token`, tách khỏi controller để test được không cần HTTP.
 */

/** Token của MỘT identity trên cluster của project, cùng địa chỉ và CA của API server */
export interface IssuedClusterToken {
  apiEndpoint: string;
  /** CA của API server (base64 PEM) — công khai, không phải bí mật */
  caData: string;
  token: string;
  expiresAt: Date;
}

export type ClusterTokenIssuer = (
  projectId: string,
  identity: ControlPlaneIdentity,
) => Promise<IssuedClusterToken>;

/**
 * Identity mà route được cấp: CHỈ `traffic`.
 *
 * §9 muốn S1 nhận ra bên gọi bằng TokenReview rồi cấp đúng SA của bên đó. Xác thực nội bộ hôm nay là bí mật
 * dùng chung (§16) — S1 không phân biệt được Service 2 với Service 3 — nên luật được giữ bằng cấu trúc: không bên
 * nội bộ nào cần `workload` hay `tooling` qua đường này (S1 tự dùng `ClusterAccess` của mình), nên không ai lấy
 * được chúng. Service 3 chỉ được `traffic` (§12.2, T12).
 */
export const ISSUABLE_IDENTITIES: ReadonlySet<ControlPlaneIdentity> = new Set([
  "traffic",
]);

/**
 * I24(c): hạn trả về không bao giờ quá 1 giờ kể từ lúc cấp, kể cả khi API server cấp dài hơn — bên nhận tính
 * lịch xin lại theo con số này, nên một hạn dài hơn thật chỉ làm nó xin lại SỚM hơn, không bao giờ muộn hơn.
 */
export function clampExpiry(expiresAt: Date, now: number): Date {
  const ceiling = now + BOUND_TOKEN_SECONDS * 1000;
  return expiresAt.getTime() > ceiling ? new Date(ceiling) : expiresAt;
}
