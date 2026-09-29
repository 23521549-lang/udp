import type { PromotionDiffKind } from "@udp/shared-types/promote";
import type {
  FlagDetailWire,
  StaleFlagsResponseWire,
} from "@udp/shared-types/wire";
import type { ReactNode } from "react";
import { count, defineMessages, plural } from "../../i18n";

type Lifecycle = FlagDetailWire["lifecycleStatus"];
type Category = StaleFlagsResponseWire["items"][number]["category"];
type FlagType = FlagDetailWire["flagType"];

/**
 * Chữ của phân hệ Flag: danh sách, panel xem nhanh, hộp tạo flag, hộp sao chép rule, trang dọn dẹp.
 * Chữ của trình sửa rule ở `rules.messages.ts`, của các khối trong panel ở `detail/detail.messages.tsx`.
 */
export const flagMessages = defineMessages({
  vi: {
    lifecycle: {
      DRAFT: "Nháp",
      ACTIVE: "Đang dùng",
      ARCHIVED: "Đã lưu trữ",
    } satisfies Record<Lifecycle, string>,
    cancel: "Huỷ",
    close: "Đóng",
    noDescription: "Chưa có mô tả.",
    list: {
      title: "Flag",
      cleanUp: "Dọn dẹp",
      createFlag: "Tạo flag",
      lead: (env: string) => `Bật, tắt và phân phối tính năng ở ${env}.`,
      miniFlags: "flag",
      miniEnabled: "đang bật",
      miniDrafts: "nháp",
      search: "Tìm flag",
      searchPlaceholder: "Tìm theo key hoặc mô tả…",
      empty: "Chưa có flag nào",
      createFirst: "Tạo flag đầu tiên",
      noMatch: "Không flag nào khớp",
      tryAnother: "Thử từ khoá khác.",
      region: "Danh sách flag",
      colKey: "Key",
      colDescription: "Mô tả",
      colEnv: (env: string) => `Ở ${env}`,
      col14Days: "14 ngày",
      col7DayEvals: "Lượt 7 ngày",
      colUpdated: "Cập nhật",
      pager: "Trang của danh sách flag",
      on: "Bật",
      off: "Tắt",
    },
    detail: {
      label: "Chi tiết flag",
      status: "Trạng thái",
      type: "Kiểu",
      variants: "Variant",
      updated: "Cập nhật",
      envTabs: "Environment",
      enabled: "đang bật",
      disabled: "đang tắt",
      noEnvConfig: "Flag chưa có cấu hình ở environment này.",
    },
    create: {
      title: "Tạo flag",
      description:
        "Flag mới ở trạng thái nháp: SDK chưa thấy nó cho tới khi kích hoạt.",
      creating: "Đang tạo…",
      submit: "Tạo flag",
      keyMissing: "Nhập key cho flag.",
      key: "Key",
      keyPlaceholder: "new-checkout…",
      type: "Kiểu",
      typeGroup: "Kiểu flag",
      typeLabel: {
        BOOLEAN: "Boolean",
        STRING: "Chuỗi",
        NUMBER: "Số",
        JSON: "JSON",
      } satisfies Record<FlagType, string>,
      variants: "Variant",
      variantKey: (n: number) => `Key variant ${String(n)}`,
      variantValue: (n: number) => `Giá trị variant ${String(n)}`,
      removeVariant: (n: number) => `Bỏ variant ${String(n)}`,
      addVariant: "Thêm variant",
      descriptionOptional: "Mô tả (tuỳ chọn)",
    },
    promote: {
      kind: {
        same: "Giữ nguyên",
        changed: "Đổi",
        added: "Thêm",
        removed: "Bỏ",
      } satisfies Record<PromotionDiffKind, string>,
      noPlan: "chưa có kế hoạch",
      copied: (env: string) => `Đã sao chép rule sang ${env}`,
      title: (env: string) => `Sao chép rule từ ${env}`,
      description:
        "Chỉ rule được chép. Bật/tắt và variant mặc định giữ nguyên ở env đích.",
      applying: "Đang áp…",
      apply: "Áp dụng",
      noTargets: "Bạn không có quyền sửa env nào khác.",
      target: "Sang environment",
      reading: "Đang đọc rule ở env đích…",
      identical: (env: string) =>
        `Rule ở ${env} đã giống hệt, không có gì để chép.`,
      table: "Thay đổi sẽ áp",
      colChange: "Thay đổi",
      colRule: "Rule",
      colGroup: "Nhóm người dùng ở đích",
      kept: "giữ nguyên",
      newGroup: "nhóm mới",
      typeToApply: (key: ReactNode) => <>Gõ {key} để áp ở production</>,
      conflict: (source: string, target: string | undefined) =>
        `Rule ở ${source} hoặc ${target ?? "env đích"} vừa được người khác sửa. Đã tải lại, hãy xem lại diff rồi áp.`,
    },
    cleanup: {
      title: "Dọn dẹp flag",
      lead: "Flag không còn tác dụng là nợ trong mã. Gộp mọi environment.",
      category: {
        UNUSED: {
          label: "Không dùng",
          hint: "Không lượt đánh giá nào trong cửa sổ quan sát.",
        },
        SETTLED: {
          label: "Đã ngã ngũ",
          hint: "Mọi lượt đều nhận cùng một variant: có thể xoá khỏi mã.",
        },
        STALE_DRAFT: {
          label: "Nháp bị bỏ quên",
          hint: "Nháp lâu ngày chưa kích hoạt.",
        },
      } satisfies Record<Category, { label: string; hint: string }>,
      archived: (ok: number, failed: number) =>
        failed === 0
          ? `Đã lưu trữ ${String(ok)} flag`
          : `Đã lưu trữ ${String(ok)} flag, ${String(failed)} flag không lưu trữ được`,
      archive: "Lưu trữ",
      categoryGroup: "Loại",
      all: "Tất cả",
      noTelemetry:
        "Project chưa nhận báo cáo telemetry nào từ SDK, nên chưa xét được “Không dùng” và “Đã ngã ngũ”.",
      empty: "Không có flag nào cần dọn",
      list: "Flag cần dọn",
      maxBatch: (n: number) => `Tối đa ${String(n)} flag mỗi lần lưu trữ.`,
      confirmTitle: (n: number) => `Lưu trữ ${String(n)} flag?`,
      confirmDescription:
        "SDK sẽ không còn nhận những flag này. Mỗi flag được lưu trữ riêng: flag nào còn lượt đánh giá sẽ được báo lại.",
      evals30d: (text: string, _n: number) => `${text} lượt/30 ngày`,
      never: "chưa từng",
      liveRollout: "đang có rollout",
      recentEvals: "còn lượt gần đây",
    },
  },
  en: {
    lifecycle: {
      DRAFT: "Draft",
      ACTIVE: "Active",
      ARCHIVED: "Archived",
    },
    cancel: "Cancel",
    close: "Close",
    noDescription: "No description yet.",
    list: {
      title: "Flags",
      cleanUp: "Clean up",
      createFlag: "Create flag",
      lead: (env: string) => `Enable, disable and roll out features in ${env}.`,
      miniFlags: "flags",
      miniEnabled: "enabled",
      miniDrafts: "drafts",
      search: "Search flags",
      searchPlaceholder: "Search by key or description…",
      empty: "No flags yet",
      createFirst: "Create the first flag",
      noMatch: "No matching flags",
      tryAnother: "Try a different search term.",
      region: "Flag list",
      colKey: "Key",
      colDescription: "Description",
      colEnv: (env: string) => `In ${env}`,
      col14Days: "14 days",
      col7DayEvals: "7-day evaluations",
      colUpdated: "Updated",
      pager: "Flag list pages",
      on: "On",
      off: "Off",
    },
    detail: {
      label: "Flag details",
      status: "Status",
      type: "Type",
      variants: "Variants",
      updated: "Updated",
      envTabs: "Environment",
      enabled: "on",
      disabled: "off",
      noEnvConfig: "This flag has no configuration in this environment.",
    },
    create: {
      title: "Create flag",
      description:
        "A new flag starts as a draft: the SDK does not see it until it is activated.",
      creating: "Creating…",
      submit: "Create flag",
      keyMissing: "Enter a key for the flag.",
      key: "Key",
      keyPlaceholder: "new-checkout…",
      type: "Type",
      typeGroup: "Flag type",
      typeLabel: {
        BOOLEAN: "Boolean",
        STRING: "String",
        NUMBER: "Number",
        JSON: "JSON",
      },
      variants: "Variants",
      variantKey: (n: number) => `Variant ${String(n)} key`,
      variantValue: (n: number) => `Variant ${String(n)} value`,
      removeVariant: (n: number) => `Remove variant ${String(n)}`,
      addVariant: "Add variant",
      descriptionOptional: "Description (optional)",
    },
    promote: {
      kind: {
        same: "Unchanged",
        changed: "Changed",
        added: "Added",
        removed: "Removed",
      },
      noPlan: "no plan yet",
      copied: (env: string) => `Copied rules to ${env}`,
      title: (env: string) => `Copy rules from ${env}`,
      description:
        "Only rules are copied. The on/off state and the default variant stay as they are in the target environment.",
      applying: "Applying…",
      apply: "Apply",
      noTargets: "You do not have permission to edit any other environment.",
      target: "To environment",
      reading: "Reading rules in the target environment…",
      identical: (env: string) =>
        `Rules in ${env} are already identical. There is nothing to copy.`,
      table: "Changes to apply",
      colChange: "Change",
      colRule: "Rule",
      colGroup: "User group in target",
      kept: "kept",
      newGroup: "new group",
      typeToApply: (key: ReactNode) => <>Type {key} to apply in production</>,
      conflict: (source: string, target: string | undefined) =>
        `Rules in ${source} or ${target ?? "the target environment"} were just changed by someone else. They were reloaded; review the diff and apply again.`,
    },
    cleanup: {
      title: "Flag cleanup",
      lead: "Flags that no longer have any effect are debt in your code. Covers all environments.",
      category: {
        UNUSED: {
          label: "Unused",
          hint: "No evaluations in the observation window.",
        },
        SETTLED: {
          label: "Settled",
          hint: "Every evaluation gets the same variant: it can be removed from the code.",
        },
        STALE_DRAFT: {
          label: "Stale draft",
          hint: "A draft that has not been activated for a long time.",
        },
      },
      archived: (ok: number, failed: number) =>
        failed === 0
          ? `Archived ${count(ok, "flag", "flags")}`
          : `Archived ${count(ok, "flag", "flags")}; ${count(failed, "flag", "flags")} could not be archived`,
      archive: "Archive",
      categoryGroup: "Category",
      all: "All",
      noTelemetry:
        "The project has not received any telemetry reports from the SDK yet, so “Unused” and “Settled” cannot be determined.",
      empty: "No flags need cleaning up",
      list: "Flags to clean up",
      maxBatch: (n: number) =>
        `You can archive at most ${count(n, "flag", "flags")} at a time.`,
      confirmTitle: (n: number) => `Archive ${count(n, "flag", "flags")}?`,
      confirmDescription:
        "The SDK will stop receiving these flags. Each flag is archived separately: any flag that still has evaluations will be reported back.",
      evals30d: (text: string, n: number) =>
        `${text} ${plural(n, "evaluation", "evaluations")}/30 days`,
      never: "never",
      liveRollout: "rollout in progress",
      recentEvals: "recent evaluations",
    },
  },
});
