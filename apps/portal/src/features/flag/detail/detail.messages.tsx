import type { ReactNode } from "react";
import { count, defineMessages, plural } from "../../../i18n";

/** Chữ của các khối trong panel flag: bật/tắt theo env, vòng đời, rule, variant, thống kê, thử đánh giá, SDK */
export const detailMessages = defineMessages({
  vi: {
    cancel: "Huỷ",
    apply: "Áp dụng",
    save: "Lưu",
    saving: "Đang lưu…",
    env: {
      savedIn: (env: string) => `Đã lưu ở ${env}`,
      enabledIn: (env: string) => `Bật ở ${env}`,
      enableFlagIn: (env: string) => `Bật flag ở ${env}`,
      defaultWhenNoMatch: "Mặc định khi không rule nào khớp",
      flagDefault: "(mặc định của flag)",
      turnOffTitle: (key: string) => `Tắt ${key} ở production?`,
      changeTitle: (key: string) => `Đổi ${key} ở production?`,
      turnOffDescription:
        "Mọi người dùng thật sẽ nhận giá trị khi tắt ngay lập tức.",
      changeDescription: "Thay đổi áp cho người dùng thật ngay khi lưu.",
      turnOffNow: "Tắt ngay",
      savedInProduction: "Đã lưu ở production",
    },
    lifecycle: {
      activated: "Đã kích hoạt flag",
      archived: "Đã lưu trữ flag",
      activate: "Kích hoạt",
      archive: "Lưu trữ",
      activateTitle: "Kích hoạt flag?",
      archiveTitle: "Lưu trữ flag?",
      activateDescription: "SDK sẽ bắt đầu nhận flag này ở mọi environment.",
      archiveDescription:
        "SDK sẽ không còn nhận flag này. Flag đang có rollout chạy thì không lưu trữ được.",
    },
    rules: {
      loading: "Đang tải rule…",
      savedIn: (env: string) => `Đã lưu rule ở ${env}`,
      discarded: (n: number) => `Đã bỏ ${String(n)} thay đổi`,
      section: "Rule",
      unsaved: (n: number, env: string) =>
        `${String(n)} thay đổi rule ở ${env}`,
      rulesIn: (env: string) => `Rule ở ${env}`,
      topDown: "xét từ trên xuống",
      saveFirst: "Lưu hoặc bỏ thay đổi trước khi sao chép",
      copyTo: "Sao chép sang…",
      addRule: "Thêm rule",
      none: "Chưa có rule. Mọi người dùng nhận variant mặc định.",
      pending: (n: number, env: string) => `${String(n)} thay đổi ở ${env}`,
      discard: "Bỏ",
      confirmTitle: "Lưu rule ở production?",
      confirmDescription: (n: number) =>
        `${String(n)} thay đổi sẽ áp cho người dùng thật.`,
    },
    sdk: {
      title: "Dùng trong mã",
      language: "Ngôn ngữ",
      node: "Node.js",
      python: "Python",
    },
    stats: {
      section: "Thống kê",
      last7Days: (env: string) => `7 ngày qua ở ${env}`,
      none: "Chưa có lượt đánh giá nào được báo về.",
      evals: (text: string, _n: number) => `${text} lượt`,
    },
    tester: {
      title: "Thử đánh giá",
      targetingKey: "targetingKey",
      attributes: "Thuộc tính (mỗi dòng key=value)",
      evaluating: "Đang đánh giá…",
      evaluate: "Đánh giá",
      result: "Kết quả đánh giá",
      value: "Giá trị",
      variant: "Variant",
      none: "(không có)",
      reason: "Lý do",
      matchedRule: "Rule khớp",
      noRule: "Không rule nào",
      rule: (priority: number, ruleType: string) =>
        `Rule ưu tiên ${String(priority)} (${ruleType})`,
      note: "Lưu ý",
      draft: "Flag còn nháp: SDK chưa thấy nó.",
    },
    variants: {
      edit: "Sửa variant",
      saved: "Đã lưu variant",
      description:
        "Giá trị mới tới SDK ở mọi environment ngay khi lưu. Variant đang được rule hay environment dùng thì không bỏ được.",
      list: "Variant (chọn một làm mặc định)",
      makeDefault: (n: number) => `Mặc định: variant ${String(n)}`,
      key: (n: number) => `Key variant ${String(n)}`,
      value: (n: number) => `Giá trị variant ${String(n)}`,
      remove: (n: number) => `Bỏ variant ${String(n)}`,
      add: "Thêm variant",
      typeToSave: (key: ReactNode) => (
        <>Gõ {key} để lưu cho flag đang phục vụ</>
      ),
    },
  },
  en: {
    cancel: "Cancel",
    apply: "Apply",
    save: "Save",
    saving: "Saving…",
    env: {
      savedIn: (env: string) => `Saved in ${env}`,
      enabledIn: (env: string) => `Enabled in ${env}`,
      enableFlagIn: (env: string) => `Enable flag in ${env}`,
      defaultWhenNoMatch: "Default when no rule matches",
      flagDefault: "(flag default)",
      turnOffTitle: (key: string) => `Turn off ${key} in production?`,
      changeTitle: (key: string) => `Change ${key} in production?`,
      turnOffDescription: "Every real user will get the off value immediately.",
      changeDescription:
        "The change applies to real users as soon as it is saved.",
      turnOffNow: "Turn off now",
      savedInProduction: "Saved in production",
    },
    lifecycle: {
      activated: "Flag activated",
      archived: "Flag archived",
      activate: "Activate",
      archive: "Archive",
      activateTitle: "Activate flag?",
      archiveTitle: "Archive flag?",
      activateDescription:
        "The SDK will start receiving this flag in every environment.",
      archiveDescription:
        "The SDK will stop receiving this flag. A flag with a running rollout cannot be archived.",
    },
    rules: {
      loading: "Loading rules…",
      savedIn: (env: string) => `Saved rules in ${env}`,
      discarded: (n: number) => `Discarded ${count(n, "change", "changes")}`,
      section: "Rules",
      unsaved: (n: number, env: string) =>
        `${count(n, "rule change", "rule changes")} in ${env}`,
      rulesIn: (env: string) => `Rules in ${env}`,
      topDown: "evaluated top to bottom",
      saveFirst: "Save or discard your changes before copying",
      copyTo: "Copy to…",
      addRule: "Add rule",
      none: "No rules yet. Every user gets the default variant.",
      pending: (n: number, env: string) =>
        `${count(n, "change", "changes")} in ${env}`,
      discard: "Discard",
      confirmTitle: "Save rules in production?",
      confirmDescription: (n: number) =>
        `${count(n, "change", "changes")} will apply to real users.`,
    },
    sdk: {
      title: "Use in code",
      language: "Language",
      node: "Node.js",
      python: "Python",
    },
    stats: {
      section: "Statistics",
      last7Days: (env: string) => `Last 7 days in ${env}`,
      none: "No evaluations have been reported yet.",
      evals: (text: string, n: number) =>
        `${text} ${plural(n, "evaluation", "evaluations")}`,
    },
    tester: {
      title: "Test an evaluation",
      targetingKey: "targetingKey",
      attributes: "Attributes (one key=value per line)",
      evaluating: "Evaluating…",
      evaluate: "Evaluate",
      result: "Evaluation result",
      value: "Value",
      variant: "Variant",
      none: "(none)",
      reason: "Reason",
      matchedRule: "Matched rule",
      noRule: "No rule",
      rule: (priority: number, ruleType: string) =>
        `Rule with priority ${String(priority)} (${ruleType})`,
      note: "Note",
      draft: "The flag is still a draft: the SDK does not see it yet.",
    },
    variants: {
      edit: "Edit variants",
      saved: "Variants saved",
      description:
        "New values reach the SDK in every environment as soon as you save. A variant used by a rule or an environment cannot be removed.",
      list: "Variants (choose one as the default)",
      makeDefault: (n: number) => `Default: variant ${String(n)}`,
      key: (n: number) => `Variant ${String(n)} key`,
      value: (n: number) => `Variant ${String(n)} value`,
      remove: (n: number) => `Remove variant ${String(n)}`,
      add: "Add variant",
      typeToSave: (key: ReactNode) => (
        <>Type {key} to save changes to a live flag</>
      ),
    },
  },
});
