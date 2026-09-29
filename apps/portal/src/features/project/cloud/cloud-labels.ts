import type {
  CloudAuthKindWire,
  CloudProviderWire,
} from "@udp/shared-types/cloud-api";
import type { CloudSetupWire } from "@udp/shared-types/wire";

/**
 * Chữ hiển thị của bước cloud (I37: khoá ở máy chủ, chuỗi ở Portal). `Record` theo đúng
 * kiểu dây: thêm một cloud, một cách xác thực hay một lý do mới mà quên dịch là lỗi biên
 * dịch, không phải một khoá tiếng Anh lọt lên màn hình.
 */

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

export const AUTH_KIND_LABEL: Record<CloudAuthKindWire, string> = {
  AWS_ROLE: "IAM role tin UDP",
  AWS_KEY: "Access key tĩnh",
  GCP_WIF: "Workload Identity Federation",
  GCP_KEY: "Khoá JSON của service account",
  AZURE_FEDERATED: "Federated credential",
  AZURE_SECRET: "Client secret",
};

type UnavailableReason = NonNullable<
  CloudSetupWire["methods"][number]["unavailableReason"]
>;
export const UNAVAILABLE_REASON: Record<UnavailableReason, string> = {
  "aws-federation-disabled":
    "Máy chủ UDP chưa bật AWS federation (principal và ExternalId).",
  "oidc-issuer-disabled":
    "Máy chủ UDP chưa bật OIDC issuer nên cloud chưa thể tin token của UDP.",
  "managed-disabled":
    "Máy chủ UDP không nhận triển khai MANAGED cho cloud này.",
};

/** Tiêu đề theo `id` của khối lệnh; id lạ vẫn hiện nội dung, chỉ thiếu tiêu đề riêng */
export const SNIPPET_TITLE: Record<string, string> = {
  "aws-trust-policy": "Trust policy của role (dán vào mục Trust relationships)",
  "aws-permissions-policy": "Policy quyền gắn vào role hoặc user",
  "gcp-workload-identity":
    "Tạo pool, provider OIDC và cho UDP mượn service account",
  "gcp-custom-role": "Vai trò tuỳ chỉnh đúng bằng quyền UDP cần",
  "azure-federated-credential":
    "App registration, federated credential và vai trò",
  "azure-app-secret": "App registration, client secret và vai trò",
};

export interface CredentialField {
  key: string;
  label: string;
  secret?: boolean;
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
      label: "ARN của role",
      placeholder: "arn:aws:iam::123456789012:role/udp-deployer…",
    },
  ],
  AWS_KEY: [
    { key: "accessKeyId", label: "Access key ID", placeholder: "AKIA…" },
    { key: "secretAccessKey", label: "Secret access key", secret: true },
  ],
  GCP_WIF: [
    { key: "gcpProjectId", label: "Project ID", placeholder: "my-project…" },
    {
      key: "projectNumber",
      label: "Project number",
      placeholder: "123456789012…",
    },
    { key: "poolId", label: "Pool ID", placeholder: "udp-pool…" },
    { key: "providerId", label: "Provider ID", placeholder: "udp-oidc…" },
    {
      key: "serviceAccountEmail",
      label: "Email service account",
      placeholder: "udp@my-project.iam.gserviceaccount.com…",
    },
  ],
  AZURE_FEDERATED: [
    { key: "tenantId", label: "Tenant ID" },
    { key: "clientId", label: "Client ID của app" },
    { key: "subscriptionId", label: "Subscription ID" },
    { key: "resourceGroup", label: "Resource group" },
  ],
  AZURE_SECRET: [
    { key: "tenantId", label: "Tenant ID" },
    { key: "clientId", label: "Client ID của app" },
    { key: "clientSecret", label: "Client secret", secret: true },
    { key: "subscriptionId", label: "Subscription ID" },
    { key: "resourceGroup", label: "Resource group" },
  ],
};
