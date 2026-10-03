import { INTERNAL_SECRET_HEADER } from "@udp/config";
import { internalClusterTokenResponseWire } from "@udp/shared-types/wire";

/**
 * Service 3 xin bound token của `udp-traffic` từ Service 1 (ADR-06, §9 Internal) [Plan #51 QĐ-3] — S3 không bao
 * giờ giữ credential cloud; thứ duy nhất nó nhận là token 1 giờ của đúng SA mà §12.2 cho nó.
 */

export interface IssuedToken {
  apiEndpoint: string;
  caData: string;
  token: string;
  expiresAt: Date;
}

export type IssueToken = (projectId: string) => Promise<IssuedToken>;

/** S1 không cấp được — HTTP của lời gọi đi kèm để lý do HOLD nói đúng chuyện (404: project chưa có cluster) */
export class ClusterTokenUnavailableError extends Error {
  constructor(readonly httpStatus: number | null) {
    super(
      httpStatus === null
        ? "Service 1 không phản hồi khi xin token cluster"
        : httpStatus === 404
          ? "project chưa có cluster"
          : `Service 1 trả ${String(httpStatus)} khi xin token cluster`,
    );
    this.name = "ClusterTokenUnavailableError";
  }
}

export function createClusterTokenClient(options: {
  baseUrl: string;
  secret: string;
  timeoutMs: number;
  fetch?: typeof fetch;
}): IssueToken {
  const doFetch = options.fetch ?? fetch;
  return async (projectId) => {
    const res = await doFetch(
      `${options.baseUrl}/internal/clusters/${encodeURIComponent(projectId)}/token`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          [INTERNAL_SECRET_HEADER]: options.secret,
        },
        body: JSON.stringify({ serviceAccount: "traffic" }),
        signal: AbortSignal.timeout(options.timeoutMs),
      },
    ).catch(() => {
      throw new ClusterTokenUnavailableError(null);
    });
    if (!res.ok) throw new ClusterTokenUnavailableError(res.status);
    const body = internalClusterTokenResponseWire.parse(await res.json());
    return { ...body, expiresAt: new Date(body.expiresAt) };
  };
}
