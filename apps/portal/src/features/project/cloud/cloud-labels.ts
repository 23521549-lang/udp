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

/**
 * [Plan #58 UX-16] Region hay dùng của từng cloud, gần Việt Nam trước: chọn từ danh sách thay vì gõ tay mã đúng từng
 * ký tự. Thành phố là tên riêng (không dịch); mã không có ở đây thì chọn "Region khác" và gõ.
 */
export const REGIONS: Record<
  CloudProviderWire,
  readonly { id: string; city: string }[]
> = {
  AWS: [
    { id: "ap-southeast-1", city: "Singapore" },
    { id: "ap-southeast-3", city: "Jakarta" },
    { id: "ap-east-1", city: "Hong Kong" },
    { id: "ap-northeast-1", city: "Tokyo" },
    { id: "ap-northeast-2", city: "Seoul" },
    { id: "ap-south-1", city: "Mumbai" },
    { id: "ap-southeast-2", city: "Sydney" },
    { id: "us-east-1", city: "N. Virginia" },
    { id: "us-west-2", city: "Oregon" },
    { id: "eu-central-1", city: "Frankfurt" },
    { id: "eu-west-1", city: "Dublin" },
  ],
  GCP: [
    { id: "asia-southeast1", city: "Singapore" },
    { id: "asia-southeast2", city: "Jakarta" },
    { id: "asia-east2", city: "Hong Kong" },
    { id: "asia-east1", city: "Changhua" },
    { id: "asia-northeast1", city: "Tokyo" },
    { id: "asia-northeast3", city: "Seoul" },
    { id: "asia-south1", city: "Mumbai" },
    { id: "australia-southeast1", city: "Sydney" },
    { id: "us-central1", city: "Iowa" },
    { id: "us-east1", city: "South Carolina" },
    { id: "europe-west3", city: "Frankfurt" },
    { id: "europe-west1", city: "St. Ghislain" },
  ],
  AZURE: [
    { id: "southeastasia", city: "Singapore" },
    { id: "eastasia", city: "Hong Kong" },
    { id: "japaneast", city: "Tokyo" },
    { id: "koreacentral", city: "Seoul" },
    { id: "centralindia", city: "Pune" },
    { id: "australiaeast", city: "New South Wales" },
    { id: "eastus", city: "Virginia" },
    { id: "westus2", city: "Washington" },
    { id: "germanywestcentral", city: "Frankfurt" },
    { id: "westeurope", city: "Amsterdam" },
    { id: "northeurope", city: "Dublin" },
  ],
};

/**
 * [Plan #58 UX-16] Trang của console nơi làm từng khối lệnh (theo `id` của khối): IAM của AWS, Cloud Shell của Google
 * Cloud và Azure. Khối lạ không có link, vẫn có lệnh.
 */
export const CONSOLE_URL: Record<string, string> = {
  "aws-trust-policy": "https://console.aws.amazon.com/iam/home#/roles",
  "aws-permissions-policy": "https://console.aws.amazon.com/iam/home#/policies",
  "gcp-workload-identity": "https://console.cloud.google.com/?cloudshell=true",
  "gcp-custom-role": "https://console.cloud.google.com/?cloudshell=true",
  "azure-federated-credential": "https://portal.azure.com/#cloudshell/",
  "azure-app-secret": "https://portal.azure.com/#cloudshell/",
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
