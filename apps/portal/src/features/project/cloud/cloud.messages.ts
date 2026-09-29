import type { CloudAuthKindWire } from "@udp/shared-types/cloud-api";
import { count, defineMessages } from "../../../i18n";
import { formatNumber } from "../../../lib/format";
import type { CredentialFieldKey, UnavailableReason } from "./cloud-labels";

/**
 * Chữ của bước cloud (I37: khoá ở máy chủ, chuỗi ở Portal): thẻ Cloud ở Tổng quan, tab Cloud của Cài
 * đặt và bước 2 của wizard. Bảng theo kiểu dây: thêm một cách xác thực hay một lý do mới mà quên dịch
 * là lỗi biên dịch, không phải một khoá tiếng Anh lọt lên màn hình.
 */
export const cloudMessages = defineMessages({
  vi: {
    authKind: {
      AWS_ROLE: "IAM role tin UDP",
      AWS_KEY: "Access key tĩnh",
      GCP_WIF: "Workload Identity Federation",
      GCP_KEY: "Khoá JSON của service account",
      AZURE_FEDERATED: "Federated credential",
      AZURE_SECRET: "Client secret",
    } satisfies Record<CloudAuthKindWire, string>,
    unavailable: {
      "aws-federation-disabled":
        "Máy chủ UDP chưa bật AWS federation (principal và ExternalId).",
      "oidc-issuer-disabled":
        "Máy chủ UDP chưa bật OIDC issuer nên cloud chưa thể tin token của UDP.",
      "managed-disabled":
        "Máy chủ UDP không nhận triển khai MANAGED cho cloud này.",
    } satisfies Record<UnavailableReason, string>,
    /** Tiêu đề theo `id` của khối lệnh; id lạ vẫn hiện nội dung, tiêu đề là chính id (`labelOf`) */
    snippet: {
      "aws-trust-policy":
        "Trust policy của role (dán vào mục Trust relationships)",
      "aws-permissions-policy": "Policy quyền gắn vào role hoặc user",
      "gcp-workload-identity":
        "Tạo pool, provider OIDC và cho UDP mượn service account",
      "gcp-custom-role": "Vai trò tuỳ chỉnh đúng bằng quyền UDP cần",
      "azure-federated-credential":
        "App registration, federated credential và vai trò",
      "azure-app-secret": "App registration, client secret và vai trò",
    },
    /** Nhãn ô nhập theo khoá payload của `credentialPayloadSchemas` */
    credentialField: {
      roleArn: "ARN của role",
      accessKeyId: "Access key ID",
      secretAccessKey: "Secret access key",
      gcpProjectId: "Project ID",
      projectNumber: "Project number",
      poolId: "Pool ID",
      providerId: "Provider ID",
      serviceAccountEmail: "Email service account",
      tenantId: "Tenant ID",
      clientId: "Client ID của app",
      subscriptionId: "Subscription ID",
      resourceGroup: "Resource group",
      clientSecret: "Client secret",
    } satisfies Record<CredentialFieldKey, string>,
    keyJsonUnreadable: "Không đọc được khoá JSON.",
    cloud: "Cloud",
    auth: "Xác thực",
    lastChecked: "Kiểm lần cuối",
    notChecked: "Chưa kiểm",
    udpAccount: "Tài khoản của UDP",
    card: {
      notConnected:
        "Chưa kết nối cloud. Project dựng hạ tầng trên tài khoản cloud của bạn (BYOC).",
      connect: "Kết nối cloud",
      change: "Đổi cloud",
      view: "Xem cấu hình cloud",
    },
    panel: {
      locked: "Cấu hình cloud chỉ hiện với Maintainer và chủ sở hữu.",
      none: "Project chưa kết nối cloud nào.",
      choose: "Chọn cloud và cách xác thực",
      change: "Đổi cấu hình",
    },
    status: {
      label: "Cloud đang dùng",
      fingerprint: "Fingerprint",
      longLived:
        "Đang dùng credential dài hạn. Nên chuyển sang cách federation để UDP không giữ bí mật nào của bạn.",
      checking: "Đang kiểm…",
      validate: "Kiểm tra credential",
      preflight: "Kiểm tra quyền",
      valid: "Credential dùng được.",
      invalid: (reason: string) => `Credential không dùng được: ${reason}`,
      preflightLabel: "Kết quả kiểm quyền",
      preflightOk: "Đủ quyền để UDP dựng hạ tầng.",
      missing: (n: number) => `Còn thiếu ${formatNumber(n)} quyền:`,
      exact: "Kết quả chính xác: cloud tự mô phỏng quyền.",
      estimated: "Kết quả ước lượng: cloud này không có API mô phỏng quyền.",
      guide: "Hướng dẫn cấp quyền",
    },
    editor: {
      label: "Cấu hình cloud",
      saved: "Đã lưu cấu hình cloud",
      unsaved: "Credential cloud đã gõ",
      saving: "Đang lưu…",
      save: "Lưu cấu hình cloud",
      mode: "Chạy trong tài khoản nào",
      myAccount: "Tài khoản của tôi",
      myAccountHint: "UDP dựng hạ tầng trong cloud của bạn",
      noCredential: "Không cần nhập credential",
      region: "Region",
      method: "Cách xác thực",
      federatedHint: "Khuyến nghị: UDP không giữ bí mật nào của bạn",
      staticHint: "Khoá dài hạn, chỉ dùng khi không có cách khác",
      staticNote:
        "Khoá dài hạn sống tới khi bạn tự thu hồi. UDP mã hoá nó khi lưu và chỉ giải mã trong vài phút mỗi lần dùng.",
      snippets: "Việc cần làm bên cloud",
      keyJson: "Khoá JSON của service account",
    },
  },
  en: {
    authKind: {
      AWS_ROLE: "IAM role that trusts UDP",
      AWS_KEY: "Static access key",
      GCP_WIF: "Workload Identity Federation",
      GCP_KEY: "Service account JSON key",
      AZURE_FEDERATED: "Federated credential",
      AZURE_SECRET: "Client secret",
    },
    unavailable: {
      "aws-federation-disabled":
        "The UDP server has not enabled AWS federation (principal and ExternalId).",
      "oidc-issuer-disabled":
        "The UDP server has not enabled its OIDC issuer, so the cloud cannot trust UDP tokens yet.",
      "managed-disabled":
        "The UDP server does not accept MANAGED deployments for this cloud.",
    },
    snippet: {
      "aws-trust-policy":
        "Role trust policy (paste it under Trust relationships)",
      "aws-permissions-policy":
        "Permissions policy to attach to the role or user",
      "gcp-workload-identity":
        "Create the pool and OIDC provider, and let UDP impersonate the service account",
      "gcp-custom-role": "Custom role with exactly the permissions UDP needs",
      "azure-federated-credential":
        "App registration, federated credential and role",
      "azure-app-secret": "App registration, client secret and role",
    },
    credentialField: {
      roleArn: "Role ARN",
      accessKeyId: "Access key ID",
      secretAccessKey: "Secret access key",
      gcpProjectId: "Project ID",
      projectNumber: "Project number",
      poolId: "Pool ID",
      providerId: "Provider ID",
      serviceAccountEmail: "Service account email",
      tenantId: "Tenant ID",
      clientId: "App client ID",
      subscriptionId: "Subscription ID",
      resourceGroup: "Resource group",
      clientSecret: "Client secret",
    },
    keyJsonUnreadable: "Could not read the JSON key.",
    cloud: "Cloud",
    auth: "Authentication",
    lastChecked: "Last checked",
    notChecked: "Not checked",
    udpAccount: "UDP's account",
    card: {
      notConnected:
        "No cloud connected. The project provisions infrastructure in your own cloud account (BYOC).",
      connect: "Connect a cloud",
      change: "Change cloud",
      view: "View cloud configuration",
    },
    panel: {
      locked:
        "The cloud configuration is visible only to Maintainers and Owners.",
      none: "The project has no cloud connected.",
      choose: "Choose a cloud and an authentication method",
      change: "Change configuration",
    },
    status: {
      label: "Current cloud",
      fingerprint: "Fingerprint",
      longLived:
        "A long-lived credential is in use. Switch to federation so that UDP holds none of your secrets.",
      checking: "Checking…",
      validate: "Validate credential",
      preflight: "Check permissions",
      valid: "The credential works.",
      invalid: (reason: string) => `The credential does not work: ${reason}`,
      preflightLabel: "Permission check result",
      preflightOk: "UDP has every permission it needs to provision.",
      missing: (n: number) =>
        `Missing ${count(n, "permission", "permissions")}:`,
      exact: "Exact result: the cloud simulated the permissions itself.",
      estimated:
        "Estimated result: this cloud has no API to simulate permissions.",
      guide: "How to grant permissions",
    },
    editor: {
      label: "Cloud configuration",
      saved: "Cloud configuration saved",
      unsaved: "cloud credentials",
      saving: "Saving…",
      save: "Save cloud configuration",
      mode: "Which account it runs in",
      myAccount: "My account",
      myAccountHint: "UDP provisions infrastructure in your cloud",
      noCredential: "No credential needed",
      region: "Region",
      method: "Authentication method",
      federatedHint: "Recommended: UDP holds none of your secrets",
      staticHint: "Long-lived key, use only when there is no other way",
      staticNote:
        "A long-lived key stays valid until you revoke it. UDP encrypts it at rest and decrypts it for only a few minutes each time it is used.",
      snippets: "What to do in your cloud",
      keyJson: "Service account JSON key",
    },
  },
});
