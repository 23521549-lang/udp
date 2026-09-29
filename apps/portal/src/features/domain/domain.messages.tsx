import type { ReactNode } from "react";
import { defineMessages } from "../../i18n";

/**
 * Chữ của trang Domain: danh sách và form cấu hình, chi tiết một domain, thao tác Day-2, webhook CI/CD.
 * Tên domain và tool (`displayName`, `toolId`) là dữ liệu của catalog — không dịch.
 */
export const domainMessages = defineMessages({
  vi: {
    page: {
      title: "Domain",
      lead: "Công cụ hạ tầng của project. Danh sách dựng từ adapter mà máy chủ nạp được, và cấu hình được kiểm trước khi lưu.",
    },
    panel: {
      applying: "Đang áp cấu hình domain",
      applyingLead:
        "Project đang chạy: cấu hình mới được áp lên cluster theo thứ tự phụ thuộc. Bảng dưới vẫn là cấu hình đang chạy cho tới khi áp xong.",
      section: "Cấu hình domain",
      unsaved: "Thay đổi cấu hình domain",
      saved: "Đã lưu cấu hình domain",
      applyingToast: "Đang áp cấu hình domain lên cluster",
      discarded: "Đã bỏ thay đổi cấu hình domain",
      discard: "Bỏ thay đổi",
      saving: "Đang lưu…",
      save: "Lưu cấu hình domain",
      confirmTitle: "Áp cấu hình lên cluster đang chạy?",
      confirmDescription:
        "Project đang chạy: các thay đổi dưới đây được áp ngay lên cluster, theo thứ tự phụ thuộc.",
      confirm: "Áp cấu hình",
      changes: "Thay đổi sẽ áp",
      /** Một dòng của hộp xác nhận: "Bật Monitoring (prometheus-grafana)" */
      change: {
        enable: (domain: string, tool: string) => `Bật ${domain} (${tool})`,
        disable: (domain: string, tool: string) =>
          `Tắt ${domain} (${tool}): gỡ công cụ khỏi cluster`,
        switch: (domain: string, from: string, to: string) =>
          `Đổi ${domain}: ${from} sang ${to}`,
        config: (domain: string, tool: string) =>
          `Đổi cấu hình ${domain} (${tool})`,
      },
    },
    row: {
      enable: (domain: string) => `Bật ${domain}`,
      details: "Chi tiết",
      noTools: "Chưa có công cụ nào cho domain này.",
      tool: "Công cụ",
      toolLine: (tool: ReactNode) => <>Công cụ: {tool}</>,
    },
    config: {
      json: "Cấu hình (JSON)",
      nothing: "Tool này không có gì để cấu hình.",
      choose: "Chọn…",
      savedSecret: "Đã lưu",
      change: "Đổi",
      keepOld: "Giữ khoá cũ",
      keepOldOf: (label: string) => `Giữ khoá cũ của ${label}`,
      invalidJson: "JSON chưa hợp lệ",
    },
    validation: {
      label: "Kiểm cấu hình",
      valid: "Cấu hình hợp lệ.",
      switchTo: (tool: string) => `Đổi sang ${tool}`,
      enable: (tool: string) => `Bật ${tool}`,
      sourceFor: (capability: string) => `Nguồn cho ${capability}`,
      chooseSource: "Chọn nguồn",
      deployOrder: "Thứ tự triển khai",
    },
    detail: {
      title: (type: string) => `Domain ${type}`,
      tool: "Công cụ",
      noTool: "Chưa chọn",
      version: "Phiên bản",
      status: "Trạng thái",
      notConfigured: "Chưa cấu hình",
      disabled: " (đang tắt)",
      updated: "Cập nhật",
      desired: "Cấu hình mong muốn",
      drift: "Drift",
      driftResult: "Kết quả drift",
      driftAt: "Chỗ trôi",
      scannedAt: (at: string) => `Quét lúc ${at}`,
    },
    actions: {
      label: "Thao tác Day-2",
      scanning: "Đang quét…",
      scan: "Quét drift ngay",
      upgradeTo: (version: string) => `Nâng cấp lên ${version}`,
      retry: "Thử lại",
      reapply: "Áp lại cấu hình mong muốn",
      upgradeTitle: (type: string, version: string) =>
        `Nâng cấp ${type} lên ${version}?`,
      upgradeDescription:
        "Cấu hình capability đã được kiểm lại với bản mới; nâng xong mà không khoẻ thì UDP báo lỗi to thay vì để lửng.",
      upgrade: "Nâng cấp",
      retryTitle: (type: string) => `Thử lại ${type}?`,
      reapplyTitle: (type: string) => `Áp lại cấu hình mong muốn cho ${type}?`,
      retryDescription:
        "UDP triển khai lại domain với đúng cấu hình đang lưu, rồi kiểm khoẻ.",
      reapplyDescription:
        "Chỗ trôi trên cluster sẽ bị ghi đè bằng cấu hình đang lưu. Trôi thường là người vận hành vá nóng: chắc chắn đó không còn cần thiết rồi hãy áp.",
      reapplyConfirm: "Áp lại",
      details: "Chi tiết nâng cấp",
      current: (version: ReactNode) => <>Bản đang chạy: {version}</>,
      unknown: "chưa rõ",
      noChanges: "Capability không đổi.",
      changes: "Capability đổi",
      added: (to: string) => `thêm ${to}`,
      removed: (from: string) => `bỏ (đang ${from})`,
      stillValid: "Validator: tổ hợp domain vẫn hợp lệ với bản mới.",
      rejected: "Validator từ chối bản mới:",
    },
    cicd: {
      title: "Webhook CI/CD",
      lead: "Bước cuối của pipeline gọi địa chỉ này, ký thân bằng secret webhook. Deploy xong flag vẫn tắt: deploy không phải release.",
      url: "Địa chỉ webhook",
      copyUrl: "Sao chép địa chỉ",
      secret: "Secret webhook",
      secretSet: "Đã sinh (không xem lại được)",
      secretUnset: "Chưa sinh: mọi webhook đều bị từ chối",
      rotate: "Xoay secret",
      generate: "Sinh secret",
      hideTemplate: "Ẩn template pipeline",
      showTemplate: "Xem template pipeline",
      template: (provider: string) => `Template pipeline ${provider}`,
      copyTemplate: "Sao chép template",
      shownOnce:
        "Sao chép ngay vào biến UDP_WEBHOOK_SECRET của CI: đây là lần duy nhất secret hiện đầy đủ.",
      savedIt: "Đã lưu secret",
      value: "Giá trị secret webhook",
      copySecret: "Sao chép secret",
      rotateTitle: "Xoay secret webhook?",
      generateTitle: "Sinh secret webhook",
      rotateDescription:
        "Secret cũ hết hiệu lực ngay: CI còn dùng nó nhận 401 tới khi bạn dán secret mới.",
      generateDescription:
        "Secret ký mọi webhook của project; UDP chỉ hiện nó một lần.",
      cancel: "Huỷ",
      generating: "Đang sinh…",
    },
  },
  en: {
    page: {
      title: "Domains",
      lead: "The project's infrastructure tools. The list is built from the adapters the server loaded, and the configuration is validated before saving.",
    },
    panel: {
      applying: "Applying domain configuration",
      applyingLead:
        "The project is running: the new configuration is applied to the cluster in dependency order. The table below shows the running configuration until the apply finishes.",
      section: "Domain configuration",
      unsaved: "domain configuration changes",
      saved: "Domain configuration saved",
      applyingToast: "Applying domain configuration to the cluster",
      discarded: "Discarded domain configuration changes",
      discard: "Discard changes",
      saving: "Saving…",
      save: "Save domain configuration",
      confirmTitle: "Apply the configuration to the running cluster?",
      confirmDescription:
        "The project is running: the changes below are applied to the cluster right away, in dependency order.",
      confirm: "Apply configuration",
      changes: "Changes to apply",
      change: {
        enable: (domain: string, tool: string) => `Enable ${domain} (${tool})`,
        disable: (domain: string, tool: string) =>
          `Disable ${domain} (${tool}): remove the tool from the cluster`,
        switch: (domain: string, from: string, to: string) =>
          `Switch ${domain}: ${from} to ${to}`,
        config: (domain: string, tool: string) =>
          `Change ${domain} configuration (${tool})`,
      },
    },
    row: {
      enable: (domain: string) => `Enable ${domain}`,
      details: "Details",
      noTools: "No tools are available for this domain yet.",
      tool: "Tool",
      toolLine: (tool: ReactNode) => <>Tool: {tool}</>,
    },
    config: {
      json: "Configuration (JSON)",
      nothing: "This tool has nothing to configure.",
      choose: "Choose…",
      savedSecret: "Saved",
      change: "Change",
      keepOld: "Keep old key",
      keepOldOf: (label: string) => `Keep the old key for ${label}`,
      invalidJson: "Invalid JSON",
    },
    validation: {
      label: "Configuration check",
      valid: "The configuration is valid.",
      switchTo: (tool: string) => `Switch to ${tool}`,
      enable: (tool: string) => `Enable ${tool}`,
      sourceFor: (capability: string) => `Provider for ${capability}`,
      chooseSource: "Choose a provider",
      deployOrder: "Deployment order",
    },
    detail: {
      title: (type: string) => `Domain ${type}`,
      tool: "Tool",
      noTool: "Not selected",
      version: "Version",
      status: "Status",
      notConfigured: "Not configured",
      disabled: " (disabled)",
      updated: "Updated",
      desired: "Desired configuration",
      drift: "Drift",
      driftResult: "Drift result",
      driftAt: "Drift details",
      scannedAt: (at: string) => `Scanned at ${at}`,
    },
    actions: {
      label: "Day-2 operations",
      scanning: "Scanning…",
      scan: "Scan for drift now",
      upgradeTo: (version: string) => `Upgrade to ${version}`,
      retry: "Retry",
      reapply: "Reapply desired configuration",
      upgradeTitle: (type: string, version: string) =>
        `Upgrade ${type} to ${version}?`,
      upgradeDescription:
        "The capability configuration has been rechecked against the new version. If the domain is unhealthy after the upgrade, UDP reports a clear error instead of leaving it half done.",
      upgrade: "Upgrade",
      retryTitle: (type: string) => `Retry ${type}?`,
      reapplyTitle: (type: string) =>
        `Reapply the desired configuration to ${type}?`,
      retryDescription:
        "UDP redeploys the domain with the saved configuration, then checks its health.",
      reapplyDescription:
        "The drift on the cluster will be overwritten with the saved configuration. Drift is often an operator's hotfix: make sure it is no longer needed before applying.",
      reapplyConfirm: "Reapply",
      details: "Upgrade details",
      current: (version: ReactNode) => <>Running version: {version}</>,
      unknown: "unknown",
      noChanges: "No capability changes.",
      changes: "Capability changes",
      added: (to: string) => `added ${to}`,
      removed: (from: string) => `removed (currently ${from})`,
      stillValid:
        "Validator: the domain combination is still valid with the new version.",
      rejected: "Validator rejected the new version:",
    },
    cicd: {
      title: "CI/CD webhook",
      lead: "The last step of the pipeline calls this URL and signs the body with the webhook secret. Flags stay off after a deploy: deploying is not releasing.",
      url: "Webhook URL",
      copyUrl: "Copy URL",
      secret: "Webhook secret",
      secretSet: "Generated (cannot be viewed again)",
      secretUnset: "Not generated: every webhook is rejected",
      rotate: "Rotate secret",
      generate: "Generate secret",
      hideTemplate: "Hide pipeline template",
      showTemplate: "View pipeline template",
      template: (provider: string) => `${provider} pipeline template`,
      copyTemplate: "Copy template",
      shownOnce:
        "Copy it now into the CI variable UDP_WEBHOOK_SECRET: this is the only time the full secret is shown.",
      savedIt: "I saved the secret",
      value: "Webhook secret value",
      copySecret: "Copy secret",
      rotateTitle: "Rotate the webhook secret?",
      generateTitle: "Generate webhook secret",
      rotateDescription:
        "The old secret stops working immediately: CI still using it gets 401 until you paste the new secret.",
      generateDescription:
        "The secret signs every webhook of the project; UDP shows it only once.",
      cancel: "Cancel",
      generating: "Generating…",
    },
  },
});
