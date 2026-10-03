import {
  ClusterCallFailedError,
  type BoundToken,
  type KubeTransport,
  type TokenSource,
} from "./direct.js";

/**
 * Nguồn token của ClusterAccess (ADR-06, §4.6).
 *
 * Hai nguồn, và ranh giới giữa chúng là toàn bộ lý do có ba ServiceAccount:
 *
 *  - `adminTokenSource`: token của CREDENTIAL CLOUD (`getKubeAuthToken` — quyền admin
 *    cluster). CHỈ dùng cho bootstrap ở pha CLUSTER_ACCESS, khi ba SA chưa tồn tại. Mọi
 *    identity nhận cùng một token: lúc này chưa có gì để tách.
 *  - `tokenRequestSource`: bound SA token 1 giờ, xin qua `TokenRequest` của API server CHO
 *    ĐÚNG SA của identity. Mọi thao tác sau bootstrap đi đường này, nên API server — không
 *    phải code của UDP — là bên từ chối khi một identity vượt quyền (I25).
 *
 * Không token nào được ghi xuống database hay đĩa (I24): chúng sống trong bộ nhớ của một
 * lượt job.
 */

export function adminTokenSource(token: string, expiresAt: Date): TokenSource {
  return {
    requestBoundToken: () => Promise.resolve({ token, expiresAt }),
  };
}

/** Một giờ — giới hạn trên của §4.6; cloud có thể cấp ngắn hơn và đó là hạn thật */
export const BOUND_TOKEN_SECONDS = 3_600;

interface TokenRequestStatus {
  status?: { token?: string; expirationTimestamp?: string };
}

export function tokenRequestSource(options: {
  apiEndpoint: string;
  transport: KubeTransport;
  /** Token được phép tạo TokenRequest — token admin của bootstrap */
  authority: () => Promise<string>;
}): TokenSource {
  return {
    async requestBoundToken(serviceAccount: string): Promise<BoundToken> {
      const [namespace, name] = serviceAccount.split("/");
      if (namespace === undefined || name === undefined) {
        throw new Error(
          `ServiceAccount phải có dạng namespace/name: ${serviceAccount}`,
        );
      }
      const path = `/api/v1/namespaces/${namespace}/serviceaccounts/${name}/token`;
      const res = await options.transport.request(
        `${options.apiEndpoint}${path}`,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${await options.authority()}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            apiVersion: "authentication.k8s.io/v1",
            kind: "TokenRequest",
            spec: { expirationSeconds: BOUND_TOKEN_SECONDS },
          }),
        },
      );
      if (!res.ok) throw new ClusterCallFailedError(res.status, "create", path);
      const body = (await res.json()) as TokenRequestStatus;
      const token = body.status?.token;
      const expires = body.status?.expirationTimestamp;
      if (token === undefined || expires === undefined) {
        throw new ClusterCallFailedError(
          res.status,
          "create",
          `${path} (thiếu token)`,
        );
      }
      return { token, expiresAt: new Date(expires) };
    },
  };
}
