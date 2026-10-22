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
    /** [Plan #58 UX-16] Làm khối lệnh đó ở đâu và thế nào; id lạ thì không có câu này */
    snippetHow: {
      "aws-trust-policy":
        "Trong IAM, mở Roles rồi Create role, chọn Custom trust policy và dán khối dưới đây.",
      "aws-permissions-policy":
        "Trong IAM, mở Policies rồi Create policy, chọn tab JSON, dán khối dưới đây, rồi gắn policy vào role hoặc user của UDP.",
      "gcp-workload-identity":
        "Mở Cloud Shell, thay <SERVICE_ACCOUNT_EMAIL> và <PROJECT_NUMBER> bằng giá trị của bạn rồi chạy các lệnh.",
      "gcp-custom-role":
        "Trong Cloud Shell, thay <GCP_PROJECT_ID> và <SERVICE_ACCOUNT_EMAIL> rồi chạy các lệnh.",
      "azure-federated-credential":
        "Mở Cloud Shell, chạy lệnh đầu để tạo app, thay <APP_ID> bằng appId vừa nhận cùng <SUBSCRIPTION_ID> và <RESOURCE_GROUP>, rồi chạy các lệnh còn lại.",
      "azure-app-secret":
        "Mở Cloud Shell, chạy lệnh đầu để tạo app, thay <APP_ID>, <SUBSCRIPTION_ID> và <RESOURCE_GROUP> rồi chạy các lệnh còn lại. Lệnh credential reset in ra client secret: chép nó vào ô bên dưới.",
    },
    mode: {
      BYOC: "Cloud của bạn (BYOC)",
      MANAGED: "Tài khoản của UDP",
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
      locked:
        "Cấu hình cloud chỉ hiện với Người duy trì và Chủ sở hữu. Nhờ chủ sở hữu project nếu bạn cần xem.",
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
      regionHint: "Nơi đặt cluster. Chọn nơi gần người dùng của bạn.",
      regionOption: (city: string, id: string) => `${city} (${id})`,
      regionOther: "Region khác…",
      regionCode: "Mã region",
      regionCodeHint: (example: string) =>
        `Mã đúng như trong console của cloud, ví dụ ${example}.`,
      openConsole: (cloud: string) => `Mở console ${cloud}`,
      finalStep: "Điền các giá trị vào ô bên dưới và lưu",
      finalStepHow:
        "Sau khi lưu, bấm Kiểm tra quyền: UDP liệt kê quyền nào còn thiếu, nếu có.",
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
    snippetHow: {
      "aws-trust-policy":
        "In IAM, open Roles, then Create role, choose Custom trust policy and paste the block below.",
      "aws-permissions-policy":
        "In IAM, open Policies, then Create policy, choose the JSON tab, paste the block below, then attach the policy to UDP's role or user.",
      "gcp-workload-identity":
        "Open Cloud Shell, replace <SERVICE_ACCOUNT_EMAIL> and <PROJECT_NUMBER> with your values and run the commands.",
      "gcp-custom-role":
        "In Cloud Shell, replace <GCP_PROJECT_ID> and <SERVICE_ACCOUNT_EMAIL> and run the commands.",
      "azure-federated-credential":
        "Open Cloud Shell and run the first command to create the app. Replace <APP_ID> with the appId it returns, plus <SUBSCRIPTION_ID> and <RESOURCE_GROUP>, then run the rest.",
      "azure-app-secret":
        "Open Cloud Shell and run the first command to create the app. Replace <APP_ID>, <SUBSCRIPTION_ID> and <RESOURCE_GROUP>, then run the rest. The credential reset command prints the client secret: copy it into the field below.",
    },
    mode: {
      BYOC: "Your own cloud (BYOC)",
      MANAGED: "UDP's account",
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
        "The cloud configuration is visible only to Maintainers and Owners. Ask the project owner if you need to see it.",
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
      regionHint: "Where the cluster runs. Pick one close to your users.",
      regionOption: (city: string, id: string) => `${city} (${id})`,
      regionOther: "Another region…",
      regionCode: "Region code",
      regionCodeHint: (example: string) =>
        `The code exactly as your cloud console shows it, for example ${example}.`,
      openConsole: (cloud: string) => `Open the ${cloud} console`,
      finalStep: "Fill in the fields below and save",
      finalStepHow:
        "After saving, click Check permissions: UDP lists any permission that is still missing.",
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
