import { readFile } from "node:fs/promises";
import type { KubeTransport } from "../direct.js";
import { caPinnedTransport } from "../transport.js";

/**
 * [Plan #67] API server của CHÍNH cụm mà tiến trình đang chạy trong đó - không phải cụm của khách (ADR-06). Một chỗ
 * dò cho ba nơi dùng: platform probe của Service 1 (Plan #53) và `TokenReview` của Service 1, Service 2.
 *
 * Trong pod, kubelet đặt `KUBERNETES_SERVICE_HOST` và gắn CA, namespace, token của ServiceAccount vào `SA_DIR`. Thiếu
 * một trong hai thì là "ngoài cụm" - mỗi bên tự quyết làm gì với điều đó: probe báo `NOT_IN_CLUSTER`, verifier thì
 * không cho service khởi động.
 *
 * Đích là API server trong cụm, không phải URL người dùng nhập, nên không cần egress guard chống SSRF; CA ghim đúng
 * `ca.crt` của cụm.
 */

export const SA_DIR = "/var/run/secrets/kubernetes.io/serviceaccount";

export interface InClusterApi {
  /** `https://<host>:<port>` */
  apiServer: string;
  /** Namespace của chính pod */
  namespace: string;
  transport: KubeTransport;
  /** Đọc lại MỖI lần: kubelet xoay token của ServiceAccount định kỳ */
  token: () => Promise<string>;
}

export type InClusterLookup =
  | { kind: "outside"; reason: "NO_SERVICE_HOST" | "NO_SERVICE_ACCOUNT" }
  | { kind: "in-cluster"; api: InClusterApi };

export async function inClusterApi(
  environment: NodeJS.ProcessEnv = process.env,
  saDir: string = SA_DIR,
): Promise<InClusterLookup> {
  const host = environment.KUBERNETES_SERVICE_HOST;
  if (host === undefined || host === "") {
    return { kind: "outside", reason: "NO_SERVICE_HOST" };
  }
  let ca: string;
  let namespace: string;
  try {
    ca = await readFile(`${saDir}/ca.crt`, "utf8");
    namespace = (await readFile(`${saDir}/namespace`, "utf8")).trim();
    await readFile(`${saDir}/token`, "utf8");
  } catch {
    // Pod chạy với automountServiceAccountToken: false - không có gì để đọc bằng
    return { kind: "outside", reason: "NO_SERVICE_ACCOUNT" };
  }
  const port = environment.KUBERNETES_SERVICE_PORT ?? "443";
  const hostPart = host.includes(":") ? `[${host}]` : host;
  return {
    kind: "in-cluster",
    api: {
      apiServer: `https://${hostPart}:${port}`,
      namespace,
      transport: caPinnedTransport(Buffer.from(ca, "utf8").toString("base64")),
      token: async () => (await readFile(`${saDir}/token`, "utf8")).trim(),
    },
  };
}
