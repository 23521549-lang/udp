import {
  IDENTITY_SERVICE_ACCOUNTS,
  type ClusterAccess,
} from "@udp/adapter-core";
import {
  caPinnedTransport,
  createDirectClusterAccess,
  type KubeTransport,
} from "@udp/cluster-access";
import type { IssueToken, IssuedToken } from "./token-client.js";

/**
 * `ClusterAccess` của Service 3 theo project (ADR-06, Plan #51 QĐ-3): CÙNG hiện thực `direct` với Service 1
 * (`@udp/cluster-access`), nguồn token là Service 1.
 *
 * Chỉ `traffic`: nguồn token từ chối mọi SA khác TRƯỚC khi gọi mạng — một dòng code S3 xin `workload` là lỗi
 * ngay tại chỗ, không phải một lời gọi S1 bị 403 (hai lớp: ở đây và ở route của S1). Token xin lại trước hạn bởi
 * chính `createDirectClusterAccess`; địa chỉ và CA của API server lấy từ lần cấp đầu. API server từ chối token
 * (cluster dựng lại) ⇒ bên gọi `forget` để lần sau dựng lại từ đầu.
 */

export interface ClusterAccessProvider {
  get(projectId: string): Promise<ClusterAccess>;
  forget(projectId: string): void;
}

const TRAFFIC = IDENTITY_SERVICE_ACCOUNTS.traffic;

export function createClusterAccessProvider(options: {
  issue: IssueToken;
  transportFor?: (caData: string) => KubeTransport;
}): ClusterAccessProvider {
  const transportFor = options.transportFor ?? caPinnedTransport;
  const built = new Map<string, Promise<ClusterAccess>>();

  const build = async (projectId: string): Promise<ClusterAccess> => {
    // Lần cấp đầu vừa cho địa chỉ + CA vừa cho token đầu tiên — không xin hai lần
    let first: IssuedToken | undefined = await options.issue(projectId);
    return createDirectClusterAccess({
      clusterId: projectId,
      apiEndpoint: first.apiEndpoint,
      transport: transportFor(first.caData),
      tokens: {
        async requestBoundToken(serviceAccount) {
          if (serviceAccount !== TRAFFIC) {
            throw new Error(
              `Service 3 chỉ có token của ${TRAFFIC} (§12.2) — không xin ${serviceAccount}`,
            );
          }
          const fresh = first ?? (await options.issue(projectId));
          first = undefined;
          return { token: fresh.token, expiresAt: fresh.expiresAt };
        },
      },
    });
  };

  return {
    get(projectId) {
      let access = built.get(projectId);
      if (access === undefined) {
        access = build(projectId);
        built.set(projectId, access);
        // Dựng hỏng thì không nhớ lỗi — lần hỏi sau thử lại
        access.catch(() => built.delete(projectId));
      }
      return access;
    },
    forget(projectId) {
      built.delete(projectId);
    },
  };
}
