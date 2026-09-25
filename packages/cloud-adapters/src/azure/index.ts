import type { CloudAdapter } from "@udp/adapter-core";
import { createPlannedAdapter } from "../core/planned-adapter.js";
import { createAzureGateway } from "./gateway.js";
import type { Fetch } from "./http.js";
import { azurePlan } from "./plan.js";

/**
 * Cloud Adapter Azure (AKS) — kế hoạch `azurePlan` trên ARM REST qua `fetch` tiêm vào,
 * qua lõi điều phối dùng chung. Một adapter phục vụ MỘT region (tên ARM: `southeastasia`).
 */
export interface AzureAdapterOptions {
  region: string;
  fetch?: Fetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

const MINUTE = 60_000;

export function createAzureAdapter(options: AzureAdapterOptions): CloudAdapter {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const now = options.now ?? Date.now;
  const sleep =
    options.sleep ??
    ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  return createPlannedAdapter({
    plan: azurePlan,
    gatewayFor: (credential) =>
      createAzureGateway({
        region: options.region,
        credential,
        fetch: fetchImpl,
        deleteWait: { intervalMs: 15_000, timeoutMs: 20 * MINUTE },
        now,
        sleep,
      }),
    waitReady: {
      intervalMs: 10_000,
      timeoutMs: 5 * MINUTE,
      timeoutByKind: { cluster: 20 * MINUTE, nodegroup: 15 * MINUTE },
    },
    teardown: { waitTimeoutMs: 20 * MINUTE, pollIntervalMs: 15_000 },
    now,
    sleep,
  });
}

export {
  azurePlan,
  azurePhysicalName,
  AZURE_VM_SIZES,
  AZURE_REQUIRED_PERMISSIONS,
} from "./plan.js";
export { azureTagCodec } from "./tags.js";
export { azureSessionSchema, type AzureSession } from "./session.js";
export {
  AZURE_FEDERATION_AUDIENCE,
  azureStoredPayloadSchemas,
  exchangeAzureCredential,
  type AzureExchangeInput,
} from "./credentials.js";
