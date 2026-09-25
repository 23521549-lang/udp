import type { CloudAdapter, ResolvedCredential } from "@udp/adapter-core";
import { createPlannedAdapter } from "../core/planned-adapter.js";
import { awsClientsFor, type AwsClients } from "./clients.js";
import { createAwsGateway } from "./gateway.js";
import { awsPlan } from "./plan.js";

/**
 * Cloud Adapter AWS (EKS) — kế hoạch `awsPlan` trên cổng SDK v3, qua lõi điều phối dùng
 * chung. Một adapter phục vụ MỘT region: `ResolvedCredential` không mang region, và mọi
 * tài nguyên của một project nằm trong một region.
 */
export interface AwsAdapterOptions {
  region: string;
  /** Tiêm client (test); mặc định dựng client SDK thật từ credential */
  clientsFor?: (credential: ResolvedCredential, region: string) => AwsClients;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/** Hạn chờ theo thực tế đo của AWS: EKS ~10–15 phút tạo, ~10 phút xoá; node group ~5 phút */
const MINUTE = 60_000;

export function createAwsAdapter(options: AwsAdapterOptions): CloudAdapter {
  const clientsFor = options.clientsFor ?? awsClientsFor;
  const now = options.now ?? Date.now;
  const sleep =
    options.sleep ??
    ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  return createPlannedAdapter({
    plan: awsPlan,
    gatewayFor: (credential) =>
      createAwsGateway({
        region: options.region,
        clients: clientsFor(credential, options.region),
        credential,
        deleteWait: { intervalMs: 15_000, timeoutMs: 30 * MINUTE },
        now,
        sleep,
      }),
    waitReady: {
      intervalMs: 10_000,
      timeoutMs: 5 * MINUTE,
      timeoutByKind: { cluster: 30 * MINUTE, nodegroup: 20 * MINUTE },
    },
    teardown: { waitTimeoutMs: 20 * MINUTE, pollIntervalMs: 15_000 },
    now,
    sleep,
  });
}

export { awsPlan, awsPhysicalName, AWS_NODE_TYPES } from "./plan.js";
export { awsTagCodec } from "./tags.js";
export { awsSessionSchema, type AwsSession } from "./clients.js";
export {
  awsStoredPayloadSchemas,
  exchangeAwsCredential,
  STATIC_CREDENTIAL_TTL_MS,
  type AwsExchangeInput,
} from "./credentials.js";
