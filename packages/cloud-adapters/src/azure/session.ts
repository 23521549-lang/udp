import type { ResolvedCredential } from "@udp/adapter-core";
import { z } from "zod";
import { GatewayError } from "../core/gateway.js";

/**
 * Payload của `ResolvedCredential` Azure SAU khi đổi token: hai access token ngắn hạn của
 * CÙNG một service principal — một cho ARM (tạo hạ tầng), một cho API server AKS (Entra
 * ID, `kubeToken`) — cùng subscription và resource group mà UDP được phép dùng.
 */
export const azureSessionSchema = z
  .object({
    armToken: z.string().min(1),
    aksToken: z.string().min(1),
    subscriptionId: z.string().uuid(),
    resourceGroup: z.string().regex(/^[\w().-]{1,90}$/),
  })
  .strict();
export type AzureSession = z.infer<typeof azureSessionSchema>;

export function azureSessionOf(credential: ResolvedCredential): AzureSession {
  if (credential.expiresAt.getTime() <= Date.now()) {
    throw new GatewayError("permission", "credential Azure đã hết hạn");
  }
  return credential.payload.use((buf) => {
    const parsed = azureSessionSchema.safeParse(
      JSON.parse(buf.toString("utf8")),
    );
    if (!parsed.success) {
      throw new GatewayError(
        "configuration",
        "payload credential Azure sai hình",
      );
    }
    return parsed.data;
  });
}
