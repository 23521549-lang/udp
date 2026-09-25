import { z } from "zod";
import type { DomainAdapter } from "@udp/adapter-core";
import { createHelmBasedAdapter } from "../../adapter-base/helm.js";
import { secretsStoreBinding } from "../../adapter-base/secrets-store.js";

/**
 * Adapter AWS Secrets Manager (§5.5 Secrets Management, Plan #34 QĐ-3) — họ Helm, hai release:
 * Secrets Store CSI Driver rồi provider của AWS.
 *
 * Định danh là IRSA: workload đọc bí mật bằng IAM role gắn vào ServiceAccount — không khoá tĩnh
 * nào trong cluster. Role ARN đi trong binding cho `SecretProviderClass` của project.
 */

export const awsSecretsManagerConfigSchema = z.object({
  region: z.string().regex(/^[a-z]{2}(-gov)?-[a-z]+-\d$/),
  /** IAM role mà workload assume qua IRSA */
  roleArn: z
    .string()
    .regex(/^arn:aws:iam::\d{12}:role\/[A-Za-z0-9+=,.@_/-]{1,128}$/),
  /** Chu kỳ CSI driver hỏi lại bí mật đã xoay, giây */
  rotationPollSeconds: z.number().int().min(30).max(3600).default(120),
});

const adapter: DomainAdapter = createHelmBasedAdapter({
  domainType: "SECRETS",
  toolId: "aws-secrets-manager",
  version: "1.0.0",
  scope: "cluster",
  capabilities: {
    provides: [{ id: "secrets.store", version: "1.0.0" }],
    requires: [],
  },
  configSchema: awsSecretsManagerConfigSchema,
  chart: {
    name: "secrets-store-csi-driver",
    version: "1.4.5",
    repo: "https://kubernetes-sigs.github.io/secrets-store-csi-driver/charts",
  },
  releaseName: "udp-csi-secrets-store",
  quotaDimensions: [],
  ignoredKeyPrefixes: ["kubectl.kubernetes.io/", "helm.sh/"],

  values: (config) => ({
    syncSecret: { enabled: true },
    enableSecretRotation: true,
    rotationPollInterval: `${String(awsSecretsManagerConfigSchema.parse(config).rotationPollSeconds)}s`,
  }),
  companions: [
    {
      releaseName: "udp-csi-provider-aws",
      chart: {
        name: "secrets-store-csi-driver-provider-aws",
        version: "0.3.9",
        repo: "https://aws.github.io/secrets-store-csi-driver-provider-aws",
      },
      values: () => ({ "secrets-store-csi-driver": { install: false } }),
    },
  ],

  bindings: (_ctx, config) => {
    const { region, roleArn } = awsSecretsManagerConfigSchema.parse(config);
    return [
      secretsStoreBinding("secrets:aws-secrets-manager", "aws", {
        region,
        roleArn,
      }),
    ];
  },
});

export default adapter;
