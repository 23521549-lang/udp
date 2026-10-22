import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SecretBuffer,
  type CloudProvider,
  type ResolvedCredential,
} from "@udp/adapter-core";
import { SimCloud } from "@udp/adapter-core/testing";
import {
  createPlannedAdapter,
  GatewayError,
  type ProviderPlan,
  type TagCodec,
} from "@udp/cloud-adapters";
import { awsPlan, awsTagCodec } from "@udp/cloud-adapters/aws";
import { azurePlan, azureTagCodec } from "@udp/cloud-adapters/azure";
import { gcpLabelCodec, gcpPlan } from "@udp/cloud-adapters/gcp";
import { createSimGateway } from "@udp/cloud-adapters/testing";
import {
  capabilitiesOf,
  type CloudPlatform,
  type ExchangeRequest,
  type PlatformConfig,
} from "../../src/modules/cloud/cloud.platform.js";
import type { OidcIssuer } from "../../src/modules/oidc/oidc.issuer.js";

/**
 * `CloudPlatform` mô phỏng cho test Service 1 — không bao giờ gọi cloud thật. Bản "trơ"
 * cho test không dùng cloud ở `inert-deps.ts`.
 */

const PLANS: Readonly<
  Record<CloudProvider, { plan: ProviderPlan; codec: TagCodec }>
> = {
  aws: { plan: awsPlan, codec: awsTagCodec },
  gcp: { plan: gcpPlan, codec: gcpLabelCodec },
  azure: { plan: azurePlan, codec: azureTagCodec },
};

/** Nhãn nhúng trong định danh của credential khách quyết định cổng mô phỏng làm gì */
export const SIM_LABELS = {
  /** Thiếu hai quyền đầu của kế hoạch (phép c8 của bộ hợp đồng) */
  missingPermissions: "thieu-quyen",
  /** Cloud từ chối đổi token — trust policy / federated credential đã bị xoá */
  revoked: "bi-thu-hoi",
} as const;

export interface SimCloudPlatform extends CloudPlatform {
  /** Cửa hậu của cloud mô phỏng — test gieo tài nguyên Kubernetes sinh, đếm lời gọi */
  readonly cloud: SimCloud;
  /** Payload đã giải mã mà mỗi lần đổi token nhận — để kiểm nó bị xoá sau đó (AC-9) */
  readonly exchanged: SecretBuffer[];
  readonly requests: Omit<ExchangeRequest, "stored">[];
}

/**
 * Registry trên `SimCloud`: adapter là kế hoạch THẬT của từng cloud qua lõi điều phối thật,
 * chỉ cổng gọi cloud là mô phỏng. Đổi token đọc payload đã giải mã như cổng thật sẽ đọc.
 */
export function simCloudPlatform(
  config: Partial<PlatformConfig> = {},
  oidcIssuer: OidcIssuer | null = null,
): SimCloudPlatform {
  const cloud = new SimCloud({
    statePath: join(mkdtempSync(join(tmpdir(), "s1-cloud-")), "cloud.json"),
  });
  const exchanged: SecretBuffer[] = [];
  const requests: Omit<ExchangeRequest, "stored">[] = [];
  const labelOf = (credential: ResolvedCredential): string =>
    credential.payload.use(
      (b) => (JSON.parse(b.toString("utf8")) as { label: string }).label,
    );

  return {
    cloud,
    exchanged,
    requests,
    capabilities: capabilitiesOf({ MANAGED_CLOUDS: [], ...config }, oidcIssuer),

    adapterFor: (provider) =>
      createPlannedAdapter({
        plan: PLANS[provider].plan,
        gatewayFor: (credential) =>
          createSimGateway({
            cloud,
            provider,
            codec: PLANS[provider].codec,
            credentialLabel: labelOf(credential),
          }),
        waitReady: { intervalMs: 0, timeoutMs: 1_000 },
        teardown: { waitTimeoutMs: 1_000, pollIntervalMs: 1 },
        sleep: () => Promise.resolve(),
      }),

    exchange: ({ stored, ...request }) => {
      exchanged.push(stored);
      requests.push(request);
      const text = stored.use((b) => b.toString("utf8"));
      if (text.includes(SIM_LABELS.revoked)) {
        return Promise.reject(
          new GatewayError(
            "permission",
            "AccessDenied: trust policy đã bị xoá",
          ),
        );
      }
      const label = text.includes(SIM_LABELS.missingPermissions)
        ? SIM_LABELS.missingPermissions
        : "du-quyen";
      const payload = new SecretBuffer(JSON.stringify({ label }));
      return Promise.resolve({
        provider: request.provider,
        mode: request.mode,
        authKind: request.authKind,
        payload,
        expiresAt: new Date(Date.now() + 3_600_000),
        dispose: () => payload.dispose(),
      });
    },
  };
}
