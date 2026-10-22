import { inClusterApi, SA_DIR } from "./api.js";
import {
  tokenReviewVerifier,
  type TokenReviewVerifier,
} from "./token-review.js";

/**
 * [Plan #67] Lớp danh tính của bên NHẬN `/internal/*`, dựng từ môi trường của pod: verifier `TokenReview` với audience
 * của chính nó, và username của các bên gọi - `system:serviceaccount:<namespace của chính pod>:<tên>`.
 *
 * Ngoài cụm thì trả `outside` để service KHÔNG khởi động: lùi về bí mật dùng chung ở chế độ `token-review` là tắt im
 * lặng lớp mà cấu hình đòi.
 */
export type InternalIdentity =
  | { kind: "outside"; reason: "NO_SERVICE_HOST" | "NO_SERVICE_ACCOUNT" }
  | { kind: "ready"; verifier: TokenReviewVerifier; callers: string[] };

export async function tokenReviewIdentity(
  audience: string,
  callerNames: readonly string[],
  environment: NodeJS.ProcessEnv = process.env,
  saDir: string = SA_DIR,
): Promise<InternalIdentity> {
  const found = await inClusterApi(environment, saDir);
  if (found.kind === "outside") return found;
  return {
    kind: "ready",
    verifier: tokenReviewVerifier({ api: found.api, audience }),
    callers: callerNames.map(
      (name) => `system:serviceaccount:${found.api.namespace}:${name}`,
    ),
  };
}
