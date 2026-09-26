import { z } from "zod";
import type { DomainAdapter, ReadOnlyAdapterContext } from "@udp/adapter-core";
import { createHelmBasedAdapter } from "../../adapter-base/helm.js";

/**
 * Adapter AWS Controllers for Kubernetes (§5.5 Infrastructure IaC, Plan #37) — họ Helm, operator
 * trong cluster: app khai bucket S3, database RDS, bảng DynamoDB bằng CR (`infra.provision`).
 *
 * ACK là MỘT controller cho mỗi dịch vụ AWS; adapter cài bộ ba dịch vụ mà app thường cần (S3 là
 * release chính, RDS và DynamoDB đi kèm), cùng một định danh IRSA — role ARN là cấu hình công
 * khai, không có khoá tĩnh nào. Chỉ chạy trên EKS (`cloud = "AWS"`, QĐ-5).
 */

export const cloud = "AWS";

const REPO = "oci://public.ecr.aws/aws-controllers-k8s";

export const ackConfigSchema = z.object({
  /** Role IAM mà ServiceAccount của controller đảm nhận qua IRSA */
  roleArn: z.string().regex(/^arn:aws:iam::\d{12}:role\/[\w+=,.@/-]{1,128}$/),
});

/** Giá trị chung của mọi controller ACK: region của cluster, định danh IRSA */
const controllerValues = (
  config: Record<string, unknown>,
  ctx: ReadOnlyAdapterContext,
) => ({
  aws: { region: ctx.region },
  installScope: "cluster",
  serviceAccount: {
    annotations: {
      "eks.amazonaws.com/role-arn": ackConfigSchema.parse(config).roleArn,
    },
  },
});

const adapter: DomainAdapter = createHelmBasedAdapter({
  domainType: "INFRA",
  toolId: "ack",
  version: "1.0.0",
  scope: "cluster",
  capabilities: {
    provides: [{ id: "infra.provision", version: "1.0.0" }],
    requires: [],
  },
  configSchema: ackConfigSchema,
  chart: { name: "s3-chart", version: "1.0.14", repo: REPO },
  releaseName: "udp-ack-s3",
  quotaDimensions: [],
  ignoredKeyPrefixes: ["kubectl.kubernetes.io/", "helm.sh/"],
  values: controllerValues,
  companions: [
    {
      releaseName: "udp-ack-rds",
      chart: { name: "rds-chart", version: "1.4.7", repo: REPO },
      values: controllerValues,
    },
    {
      releaseName: "udp-ack-dynamodb",
      chart: { name: "dynamodb-chart", version: "1.2.15", repo: REPO },
      values: controllerValues,
    },
  ],

  bindings: () => [
    {
      id: "infra.provision",
      version: "1.0.0",
      providedBy: "infra:ack",
      attributes: {
        provider: "ack",
        mode: "operator",
        clouds: "aws",
        services: "dynamodb,rds,s3",
      },
    },
  ],
});

export default adapter;
