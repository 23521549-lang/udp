import type { SdkKeyWire } from "@udp/shared-types/wire";
import { count, defineMessages } from "../../../i18n";
import { formatNumber } from "../../../lib/format";
import type { SdkLang } from "./sdk-quickstart";

/** Chữ của các tab trong Cài đặt project: SDK key, environment, thành viên, nhật ký, project */
export const settingsMessages = defineMessages({
  vi: {
    cancel: "Huỷ",
    creating: "Đang tạo…",
    delete: "Xoá",
    production: "Production",
    autoDeploy: "Tự deploy",
    audit: {
      label: "Nhật ký kiểm toán",
      empty: "Không có dòng nào",
      list: "Nhật ký",
      pages: "Trang của nhật ký",
      before: "Trước",
      after: "Sau",
    },
    environments: {
      label: "Environment",
      added: (name: string) => `Đã thêm environment ${name}`,
      removed: (name: string) => `Đã xoá environment ${name}`,
      applying: (done: string) =>
        `${done}. Đang áp lên cluster, xem tiến độ ở trang Hạ tầng.`,
      newName: "Tên environment mới",
      newNamePlaceholder: "qa…",
      add: "Thêm",
      full: (n: number) => `Đã đủ ${formatNumber(n)} environment`,
      rules: (max: number) =>
        `Tên là nhãn DNS (chữ thường, số, gạch ngang; tối đa ${formatNumber(max)} ký tự) và KHÔNG đổi được: namespace, tiền tố SDK key đều suy từ nó. Environment đã có lịch sử (SDK key, deploy, bật tắt flag) giữ lại cùng lịch sử, không xoá được.`,
      list: "Environment của project",
      isProduction: (name: string) => `${name} là production`,
      autoDeployOf: (name: string) => `${name} tự deploy từ webhook`,
      deleteOf: (name: string) => `Xoá environment ${name}`,
      demoteTitle: (name: string) => `Bỏ đánh dấu production của ${name}?`,
      demoteBody:
        "Environment này sẽ không còn cần xác nhận khi bật tắt flag, không còn cần gõ lại khi rollback, và Lập trình viên sửa được cấu hình của nó.",
      demote: "Bỏ đánh dấu production",
      deleteTitle: (name: string) => `Xoá environment ${name}?`,
      deleteBody:
        "Cấu hình flag của environment này bị xoá theo. Environment đã có lịch sử thì server từ chối và giữ nguyên.",
      deleteConfirm: "Xoá environment",
    },
    members: {
      label: "Thành viên",
      added: "Đã thêm thành viên",
      roleChanged: (email: string, role: string) =>
        `Đã đổi vai ${email} thành ${role}`,
      removed: (email: string) => `Đã xoá ${email} khỏi project`,
      transferred: "Đã chuyển quyền sở hữu",
      newEmail: "Email thành viên mới",
      newEmailPlaceholder: "email@congty.vn…",
      newRole: "Vai của thành viên mới",
      invite: "Mời",
      list: "Thành viên của project",
      roleOf: (email: string) => `Vai của ${email}`,
      transferTo: (email: string) => `Chuyển quyền chủ cho ${email}`,
      transfer: "Chuyển chủ",
      removeOf: (email: string) => `Xoá ${email} khỏi project`,
      remove: "Xoá",
      matrix: "Mỗi vai làm được gì",
      action: "Việc",
      yes: "Có",
      transferTitle: "Chuyển quyền sở hữu?",
      transferBody: (email: string) =>
        `${email} thành chủ sở hữu; bạn trở thành Người duy trì. Không tự hoàn tác được.`,
      transferConfirm: "Chuyển",
    },
    project: {
      label: "Project",
      quotaSaved: "Đã lưu trần tài nguyên",
      ttlSaved: "Đã lưu hạn dùng",
      deleted: "Đã xoá project",
      name: "Tên",
      runtime: "Runtime",
      createdAt: "Tạo lúc",
      quota: "Trần tài nguyên",
      quotaNote:
        "Là giới hạn thật, không phải gợi ý: lượt dựng hạ tầng vượt trần bị từ chối trước khi tạo gì trên cloud.",
      maxNodes: "Số node tối đa",
      maxNodeSize: "Cỡ node tối đa",
      maxDatabases: "Số database tối đa",
      maxStorageGb: "Dung lượng tối đa (GB)",
      maxLoadBalancers: "Số load balancer tối đa",
      saveQuota: "Lưu trần",
      ttl: "Hạn dùng",
      ttlNote:
        "Hết hạn thì UDP chỉ cảnh báo chủ sở hữu, không tự xoá tài nguyên của bạn.",
      expiryDate: "Ngày hết hạn",
      ttlPast:
        "Ngày hết hạn phải sau hôm nay. Chọn một ngày khác, hoặc bấm Bỏ hạn nếu project không cần hạn.",
      saveTtl: "Lưu hạn",
      clearTtl: "Bỏ hạn",
      danger: "Vùng nguy hiểm",
      deleteProject: "Xoá project",
      deleteTitle: (name: string) => `Xoá ${name}?`,
      deleteBody:
        "UDP dừng lượt triển khai đang chạy (nếu có) rồi xoá mọi tài nguyên đã dựng trên cloud của bạn. Nhật ký kiểm toán được giữ.",
    },
    keys: {
      typeHint: {
        SERVER:
          "Đánh giá tại chỗ: nhận toàn bộ rule. Chỉ dùng ở backend, không bao giờ nhúng vào trình duyệt.",
        CLIENT:
          "Gửi context lên và nhận kết quả (OFREP): rule không bao giờ rời máy chủ. Dùng được ở trình duyệt.",
      } satisfies Record<SdkKeyWire["keyType"], string>,
      typeName: {
        SERVER: "Key server",
        CLIENT: "Key client",
      } satisfies Record<SdkKeyWire["keyType"], string>,
      revoked: "Đã thu hồi key",
      inEnv: (env: string) => `SDK key ở ${env}`,
      create: "Tạo key",
      /** [Plan #58 UX-17] Trống: vì sao trống, cần gì, và một nút */
      emptyTitle: (env: string) => `Chưa có SDK key nào ở ${env}`,
      emptyBody:
        "Ứng dụng cần một SDK key để đọc flag, và mỗi environment có key riêng. Tạo key rồi làm theo ba bước cài SDK bên dưới.",
      emptyNotOwner:
        "Ứng dụng cần một SDK key để đọc flag, và mỗi environment có key riêng. Chỉ chủ sở hữu project tạo được key: hãy nhờ họ tạo.",
      /** [Plan #58 UX-13] Ba bước cài SDK, cho Node, Python và trình duyệt */
      quickstart: {
        title: "Cài SDK vào ứng dụng",
        lead: "Ba bước. Đoạn mã đã điền sẵn địa chỉ UDP của bạn.",
        language: "Ngôn ngữ",
        lang: {
          node: "Node.js",
          python: "Python",
          browser: "Trình duyệt",
        } satisfies Record<SdkLang, string>,
        steps: "Các bước cài SDK",
        codeOf: (lang: string, step: string) => `Mã ${lang}: ${step}`,
        install: "Cài gói",
        installHint:
          "SDK của OpenFeature (chuẩn mở cho feature flag) và provider nối nó với UDP.",
        init: "Khởi tạo với key và địa chỉ",
        initServer:
          "Đặt key server vào biến môi trường UDP_SDK_KEY của ứng dụng, đừng ghi thẳng vào mã.",
        initBrowser:
          "Dùng key client: nó chỉ đọc được giá trị flag nên đặt trong trình duyệt được. Gán nó cho UDP_CLIENT_KEY.",
        evaluate: "Hỏi giá trị một flag",
        evaluateHint: (flag: string) =>
          `Thay ${flag} bằng key của flag bạn tạo. Khi chưa nối được UDP, hàm trả giá trị mặc định nên ứng dụng vẫn chạy.`,
      },
      revokedAt: (when: string) => `Đã thu hồi ${when}`,
      unusedWeek: "Chưa dùng sau 7 ngày",
      unused: "Chưa dùng",
      usedAt: (when: string) => `Dùng ${when}`,
      revoke: "Thu hồi",
      revokeTitle: "Thu hồi key này?",
      revokeBody: (masked: string) =>
        `Ứng dụng đang dùng ${masked} sẽ mất quyền đọc flag ngay.`,
      createdTitle: "Key đã tạo",
      createdBody:
        "Sao chép ngay: đây là lần duy nhất key hiện đầy đủ, không xem lại được.",
      savedIt: "Đã lưu key",
      sdkKey: "SDK key",
      copy: "Sao chép key",
      createTitle: (env: string) => `Tạo SDK key ở ${env}`,
      type: "Loại key",
      label: "Nhãn (tuỳ chọn)",
    },
  },
  en: {
    cancel: "Cancel",
    creating: "Creating…",
    delete: "Delete",
    production: "Production",
    autoDeploy: "Auto-deploy",
    audit: {
      label: "Audit log",
      empty: "No entries",
      list: "Audit log entries",
      pages: "Audit log pages",
      before: "Before",
      after: "After",
    },
    environments: {
      label: "Environments",
      added: (name: string) => `Environment ${name} added`,
      removed: (name: string) => `Environment ${name} deleted`,
      applying: (done: string) =>
        `${done}. Applying to the cluster; follow the progress on the Infrastructure page.`,
      newName: "New environment name",
      newNamePlaceholder: "qa…",
      add: "Add",
      full: (n: number) =>
        `Limit of ${count(n, "environment", "environments")} reached`,
      rules: (max: number) =>
        `The name is a DNS label (lowercase letters, digits and hyphens; at most ${count(max, "character", "characters")}) and CANNOT be changed: the namespace and the SDK key prefix are derived from it. An environment with history (SDK keys, deployments, flag toggles) is kept along with that history and cannot be deleted.`,
      list: "Project environments",
      isProduction: (name: string) => `${name} is production`,
      autoDeployOf: (name: string) => `${name} auto-deploys from webhooks`,
      deleteOf: (name: string) => `Delete environment ${name}`,
      demoteTitle: (name: string) => `Unmark ${name} as production?`,
      demoteBody:
        "Toggling flags in this environment will no longer need confirmation, rolling back will no longer need retyping, and Developers will be able to edit its configuration.",
      demote: "Unmark production",
      deleteTitle: (name: string) => `Delete environment ${name}?`,
      deleteBody:
        "This environment's flag configuration is deleted with it. If the environment has history, the server refuses and keeps it unchanged.",
      deleteConfirm: "Delete environment",
    },
    members: {
      label: "Members",
      added: "Member added",
      roleChanged: (email: string, role: string) =>
        `Changed the role of ${email} to ${role}`,
      removed: (email: string) => `Removed ${email} from the project`,
      transferred: "Ownership transferred",
      newEmail: "New member email",
      newEmailPlaceholder: "email@company.com…",
      newRole: "New member role",
      invite: "Invite",
      list: "Project members",
      roleOf: (email: string) => `Role of ${email}`,
      transferTo: (email: string) => `Transfer ownership to ${email}`,
      transfer: "Transfer ownership",
      removeOf: (email: string) => `Remove ${email} from the project`,
      remove: "Remove",
      matrix: "What each role can do",
      action: "Action",
      yes: "Yes",
      transferTitle: "Transfer ownership?",
      transferBody: (email: string) =>
        `${email} becomes the Owner and you become a Maintainer. You cannot undo this yourself.`,
      transferConfirm: "Transfer",
    },
    project: {
      label: "Project",
      quotaSaved: "Resource quota saved",
      ttlSaved: "Expiry date saved",
      deleted: "Project deleted",
      name: "Name",
      runtime: "Runtime",
      createdAt: "Created",
      quota: "Resource quota",
      quotaNote:
        "A hard limit, not a suggestion: provisioning beyond the quota is rejected before anything is created in your cloud.",
      maxNodes: "Maximum nodes",
      maxNodeSize: "Maximum node size",
      maxDatabases: "Maximum databases",
      maxStorageGb: "Maximum storage (GB)",
      maxLoadBalancers: "Maximum load balancers",
      saveQuota: "Save quota",
      ttl: "Expiry",
      ttlNote:
        "When it expires, UDP only warns the owner; your resources are never deleted automatically.",
      expiryDate: "Expiry date",
      ttlPast:
        "The expiry date must be after today. Pick another date, or clear it if the project needs no expiry.",
      saveTtl: "Save expiry date",
      clearTtl: "Clear expiry date",
      danger: "Danger zone",
      deleteProject: "Delete project",
      deleteTitle: (name: string) => `Delete ${name}?`,
      deleteBody:
        "UDP stops the running deployment (if any), then deletes every resource it provisioned in your cloud. The audit log is kept.",
    },
    keys: {
      typeHint: {
        SERVER:
          "Evaluates locally and receives every rule. Use only on the backend, never embed it in a browser.",
        CLIENT:
          "Sends the context and receives the result (OFREP): rules never leave the server. Safe to use in a browser.",
      },
      typeName: {
        SERVER: "Server key",
        CLIENT: "Client key",
      },
      revoked: "Key revoked",
      inEnv: (env: string) => `SDK keys in ${env}`,
      create: "Create key",
      emptyTitle: (env: string) => `No SDK keys in ${env} yet`,
      emptyBody:
        "Your app needs an SDK key to read flags, and each environment has its own keys. Create a key, then follow the three setup steps below.",
      emptyNotOwner:
        "Your app needs an SDK key to read flags, and each environment has its own keys. Only the project owner can create keys, so ask them to create one.",
      quickstart: {
        title: "Add the SDK to your app",
        lead: "Three steps. The code already contains your UDP address.",
        language: "Language",
        lang: {
          node: "Node.js",
          python: "Python",
          browser: "Browser",
        },
        steps: "SDK setup steps",
        codeOf: (lang: string, step: string) => `${lang} code: ${step}`,
        install: "Install the packages",
        installHint:
          "The OpenFeature SDK (an open standard for feature flags) and the provider that connects it to UDP.",
        init: "Initialize with your key and address",
        initServer:
          "Put the server key in your app's UDP_SDK_KEY environment variable instead of writing it in the code.",
        initBrowser:
          "Use a client key: it can only read flag values, so it is safe in a browser. Assign it to UDP_CLIENT_KEY.",
        evaluate: "Ask for a flag value",
        evaluateHint: (flag: string) =>
          `Replace ${flag} with the key of a flag you created. Until UDP is reachable, the call returns the default value, so your app keeps working.`,
      },
      revokedAt: (when: string) => `Revoked ${when}`,
      unusedWeek: "Unused after 7 days",
      unused: "Never used",
      usedAt: (when: string) => `Used ${when}`,
      revoke: "Revoke",
      revokeTitle: "Revoke this key?",
      revokeBody: (masked: string) =>
        `Apps using ${masked} lose access to flags immediately.`,
      createdTitle: "Key created",
      createdBody:
        "Copy it now: this is the only time the full key is shown, and it cannot be viewed again.",
      savedIt: "I saved the key",
      sdkKey: "SDK key",
      copy: "Copy key",
      createTitle: (env: string) => `Create SDK key in ${env}`,
      type: "Key type",
      label: "Label (optional)",
    },
  },
});
