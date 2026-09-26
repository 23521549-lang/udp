import type { ClusterAccess } from "@udp/adapter-core";
import { METRICS_PROVIDER } from "@udp/config";

/**
 * Truy cập cluster của project được NHỚ trong Service 1 (Plan #39 QĐ-3, D-P30).
 *
 * Dựng một `ClusterAccess` cần credential cloud và vài lời gọi API cloud (trạng thái cluster,
 * token quản trị) — làm việc đó cho MỖI phép đo metrics của canary là hàng chục lời gọi cloud mỗi
 * phút. Access chỉ dựa vào token quản trị (credential cloud huỷ ngay sau khi xin token), nên nhớ
 * được tới khi token đó sắp hết hạn, trừ biên `marginMs`; lần hỏi kế tiếp dựng lại.
 *
 * Hai lời hỏi đồng thời cho cùng project chờ CÙNG một lần dựng. Dựng hỏng thì không nhớ lỗi —
 * lần hỏi sau thử lại.
 */

export interface ResolvedAccess {
  access: ClusterAccess;
  expiresAt: Date;
}

export interface ClusterAccessCache {
  get(projectId: string): Promise<ClusterAccess>;
  /** Bỏ bản nhớ của project — API server từ chối token (cluster dựng lại, credential đổi) */
  forget(projectId: string): void;
}

export function createClusterAccessCache(options: {
  resolve: (projectId: string) => Promise<ResolvedAccess>;
  marginMs?: number;
  now?: () => number;
}): ClusterAccessCache {
  const margin =
    options.marginMs ?? METRICS_PROVIDER.clusterAccessRenewMarginMs;
  const now = options.now ?? Date.now;
  const cached = new Map<string, ResolvedAccess>();
  const pending = new Map<string, Promise<ResolvedAccess>>();

  return {
    async get(projectId) {
      const hit = cached.get(projectId);
      if (hit !== undefined && hit.expiresAt.getTime() - margin > now()) {
        return hit.access;
      }
      let inFlight = pending.get(projectId);
      if (inFlight === undefined) {
        inFlight = options
          .resolve(projectId)
          .then((fresh) => {
            cached.set(projectId, fresh);
            return fresh;
          })
          .finally(() => pending.delete(projectId));
        pending.set(projectId, inFlight);
      }
      return (await inFlight).access;
    },
    forget(projectId) {
      cached.delete(projectId);
    },
  };
}
