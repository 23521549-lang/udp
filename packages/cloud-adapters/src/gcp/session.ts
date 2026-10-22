import type { ResolvedCredential } from "@udp/adapter-core";
import { z } from "zod";
import { GatewayError } from "../core/gateway.js";

/**
 * Payload của `ResolvedCredential` GCP SAU khi đổi token: một access token OAuth ngắn hạn
 * của service account, cùng project GCP mà nó thao tác. Đọc qua `SecretBuffer.use()` mỗi
 * lần cần, không giữ bản sao ở phạm vi module.
 */
export const gcpSessionSchema = z
  .object({
    accessToken: z.string().min(1),
    gcpProjectId: z.string().regex(/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/),
  })
  .strict();
export type GcpSession = z.infer<typeof gcpSessionSchema>;

export function gcpSessionOf(credential: ResolvedCredential): GcpSession {
  if (credential.expiresAt.getTime() <= Date.now()) {
    throw new GatewayError("permission", "credential GCP đã hết hạn");
  }
  return credential.payload.use((buf) => {
    const parsed = gcpSessionSchema.safeParse(JSON.parse(buf.toString("utf8")));
    if (!parsed.success) {
      throw new GatewayError(
        "configuration",
        "payload credential GCP sai hình",
      );
    }
    return parsed.data;
  });
}
