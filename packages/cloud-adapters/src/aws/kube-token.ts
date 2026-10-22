import { Sha256 } from "@aws-crypto/sha256-js";
import { HttpRequest } from "@smithy/protocol-http";
import { SignatureV4 } from "@smithy/signature-v4";
import type { ResolvedCredential } from "@udp/adapter-core";
import { awsCredentialsOf } from "./clients.js";
import { aws } from "./errors.js";

/**
 * Token API server của EKS (§4.2 `getKubeAuthToken`, ADR-06): một URL
 * `sts:GetCallerIdentity` được KÝ TRƯỚC, kèm header `x-k8s-aws-id: <cluster>`, mã hoá
 * base64url sau tiền tố `k8s-aws-v1.` — đúng định dạng `aws-iam-authenticator` kiểm.
 *
 * URL ký sống 60 giây để gọi STS, nhưng EKS chấp nhận token trong 15 phút kể từ lúc ký;
 * `expiresAt` khai 14 phút để bên gọi đổi token trước khi API server từ chối.
 */
export const KUBE_TOKEN_TTL_MS = 14 * 60 * 1000;
const PRESIGN_SECONDS = 60;

const base64url = (s: string): string =>
  Buffer.from(s, "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

function queryString(query: Record<string, string | string[] | null>): string {
  return Object.entries(query)
    .flatMap(([k, v]) =>
      v === null
        ? []
        : (Array.isArray(v) ? v : [v]).map(
            (one) => `${encodeURIComponent(k)}=${encodeURIComponent(one)}`,
          ),
    )
    .join("&");
}

export async function eksKubeToken(
  credential: ResolvedCredential,
  region: string,
  clusterName: string,
  now: () => number = Date.now,
): Promise<{ token: string; expiresAt: Date }> {
  const hostname = `sts.${region}.amazonaws.com`;
  const signer = new SignatureV4({
    credentials: awsCredentialsOf(credential),
    region,
    service: "sts",
    sha256: Sha256,
  });
  const signed = await aws(() =>
    signer.presign(
      new HttpRequest({
        method: "GET",
        protocol: "https:",
        hostname,
        path: "/",
        query: { Action: "GetCallerIdentity", Version: "2011-06-15" },
        headers: { host: hostname, "x-k8s-aws-id": clusterName },
      }),
      { expiresIn: PRESIGN_SECONDS, signingDate: new Date(now()) },
    ),
  );
  const url = `https://${hostname}/?${queryString(signed.query ?? {})}`;
  return {
    token: `k8s-aws-v1.${base64url(url)}`,
    expiresAt: new Date(now() + KUBE_TOKEN_TTL_MS),
  };
}
