import type { CloudAdapter } from "@udp/adapter-core";
import { createPlannedAdapter } from "../core/planned-adapter.js";
import { createGcpGateway } from "./gateway.js";
import type { Fetch } from "./http.js";
import { gcpPlan } from "./plan.js";

/**
 * Cloud Adapter GCP (GKE) — kế hoạch `gcpPlan` trên REST của Google qua `fetch` tiêm vào,
 * qua lõi điều phối dùng chung. Một adapter phục vụ MỘT region.
 */
export interface GcpAdapterOptions {
  region: string;
  fetch?: Fetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

const MINUTE = 60_000;

export function createGcpAdapter(options: GcpAdapterOptions): CloudAdapter {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const now = options.now ?? Date.now;
  const sleep =
    options.sleep ??
    ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  return createPlannedAdapter({
    plan: gcpPlan,
    gatewayFor: (credential) =>
      createGcpGateway({
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

export { gcpPlan, gcpPhysicalName, GCP_MACHINE_TYPES } from "./plan.js";
export { gcpLabelCodec } from "./labels.js";
export { gcpSessionSchema, type GcpSession } from "./session.js";
export {
  exchangeGcpCredential,
  gcpStoredPayloadSchemas,
  STATIC_CREDENTIAL_TTL_MS as GCP_STATIC_CREDENTIAL_TTL_MS,
  type GcpExchangeInput,
} from "./credentials.js";
