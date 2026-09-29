import type {
  CloudAuthKindWire,
  CloudProviderWire,
} from "@udp/shared-types/cloud-api";
import type { CloudSetupWire } from "@udp/shared-types/wire";

/**
 * Bảng của bước cloud KHÔNG phải câu: tên thương hiệu của cloud, region gợi ý và danh sách trường của
 * từng cách xác thực. Câu hiển thị (tên cách xác thực, lý do không dùng được, tiêu đề khối lệnh, nhãn ô
 * nhập) ở `cloud.messages.ts`, hai ngôn ngữ.
 */

/** Tên thương hiệu — không dịch */
export const PROVIDER_LABEL: Record<CloudProviderWire, string> = {
  AWS: "AWS",
  GCP: "Google Cloud",
  AZURE: "Azure",
};

/** Region gợi ý (Singapore) — khách đổi được; máy chủ chỉ kiểm định dạng */
export const DEFAULT_REGION: Record<CloudProviderWire, string> = {
  AWS: "ap-southeast-1",
  GCP: "asia-southeast1",
  AZURE: "southeastasia",
};

export type UnavailableReason = NonNullable<
  CloudSetupWire["methods"][number]["unavailableReason"]
>;

/** Khoá payload của `credentialPayloadSchemas` — cũng là khoá nhãn trong `cloudMessages.credentialField` */
export type CredentialFieldKey =
  | "roleArn"
  | "accessKeyId"
  | "secretAccessKey"
  | "gcpProjectId"
  | "projectNumber"
  | "poolId"
  | "providerId"
  | "serviceAccountEmail"
  | "tenantId"
  | "clientId"
  | "subscriptionId"
  | "resourceGroup"
  | "clientSecret";

export interface CredentialField {
  key: CredentialFieldKey;
  secret?: boolean;
  /** Giá trị mẫu (mã kỹ thuật, không dịch) */
  placeholder?: string;
}

/** Trường của từng cách xác thực — tên trùng khoá payload của `credentialPayloadSchemas` */
export const CREDENTIAL_FIELDS: Record<
  Exclude<CloudAuthKindWire, "GCP_KEY">,
  readonly CredentialField[]
> = {
  AWS_ROLE: [
    {
      key: "roleArn",
      placeholder: "arn:aws:iam::123456789012:role/udp-deployer…",
    },
  ],
  AWS_KEY: [
    { key: "accessKeyId", placeholder: "AKIA…" },
    { key: "secretAccessKey", secret: true },
  ],
  GCP_WIF: [
    { key: "gcpProjectId", placeholder: "my-project…" },
    {
      key: "projectNumber",
      placeholder: "123456789012…",
    },
    { key: "poolId", placeholder: "udp-pool…" },
    { key: "providerId", placeholder: "udp-oidc…" },
    {
      key: "serviceAccountEmail",
      placeholder: "udp@my-project.iam.gserviceaccount.com…",
    },
  ],
  AZURE_FEDERATED: [
    { key: "tenantId" },
    { key: "clientId" },
    { key: "subscriptionId" },
    { key: "resourceGroup" },
  ],
  AZURE_SECRET: [
    { key: "tenantId" },
    { key: "clientId" },
    { key: "clientSecret", secret: true },
    { key: "subscriptionId" },
    { key: "resourceGroup" },
  ],
};
