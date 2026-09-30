import type {
  DomainCatalogEntryWire,
  DomainDriftWire,
  ProjectDomainWire,
} from "@udp/shared-types/wire";
import { defineMessages } from "../../i18n";

/**
 * Chữ của domain dùng ở nhiều phân hệ (trang Domain, Kiến trúc, nhật ký job, catalog) — I37: mã ở máy chủ,
 * câu ở Portal. Bảng theo đúng kiểu dây: thêm một trạng thái mà quên câu là lỗi biên dịch.
 *
 * [Plan #58 UX-8] Một khái niệm một từ: vòng đời ACTIVE là "Đang hoạt động" (như project), còn "Ổn định" để dành cho
 * SỨC KHOẺ (`toolHealth`); lệch khỏi cấu hình đã lưu luôn là "Lệch cấu hình" (bảng thuật ngữ, mục drift).
 */
export const domainLabelMessages = defineMessages({
  vi: {
    tier: {
      CORE: "Cốt lõi",
      STANDARD: "Tiêu chuẩn",
      ADVANCED: "Nâng cao",
    } satisfies Record<DomainCatalogEntryWire["tier"], string>,
    status: {
      PENDING: "Chờ triển khai",
      DEPLOYING: "Đang triển khai",
      ACTIVE: "Đang hoạt động",
      SWITCHING: "Đang đổi tool",
      RECONFIGURING: "Đang cấu hình lại",
      TEARINGDOWN: "Đang gỡ",
      BLOCKED: "Bị chặn",
      ERROR: "Lỗi",
    } satisfies Record<NonNullable<ProjectDomainWire["status"]>, string>,
    drift: {
      NOT_DEPLOYED: "Chưa triển khai, chưa có gì để so",
      CLEAN: "Khớp cấu hình đã lưu",
      DRIFTED: "Lệch cấu hình",
      SCAN_FAILED: "Chưa kiểm được: lần quét gần nhất không chạy được",
    } satisfies Record<DomainDriftWire["verdict"], string>,
    /** Câu cho một vấn đề của validator; tên tool đã đọc được (`datadog (Giám sát)`) */
    issue: {
      missingCapability: (tool: string, capability: string) =>
        `${tool} cần ${capability}, nhưng chưa tool nào đang bật cung cấp nó.`,
      missingAnyOf: (tool: string, options: string) =>
        `${tool} cần ít nhất một trong: ${options}.`,
      versionMismatch: (tool: string, others: string) =>
        `Phiên bản không tương thích: ${tool} với ${others}.`,
      conflict: (tools: readonly string[], subject: string) =>
        `Không bật đồng thời được ${tools.join(" và ")} (${subject}).`,
      ambiguousProvider: (capability: string, tools: string) =>
        `Nhiều tool cùng cung cấp ${capability}: ${tools}. Chọn một.`,
      cyclicDependency:
        "Khai báo capability của các tool tạo thành vòng phụ thuộc.",
      cloudMismatch: (tool: string, runsOn: string, projectCloud: string) =>
        `${tool} chỉ chạy trên ${runsOn}, còn project dùng ${projectCloud}.`,
      recommendedMissing: (tool: string, capability: string) =>
        `${tool} hoạt động tốt hơn khi có ${capability}. Không bắt buộc.`,
    },
  },
  en: {
    tier: {
      CORE: "Core",
      STANDARD: "Standard",
      ADVANCED: "Advanced",
    },
    status: {
      PENDING: "Pending deployment",
      DEPLOYING: "Deploying",
      ACTIVE: "Active",
      SWITCHING: "Switching tool",
      RECONFIGURING: "Reconfiguring",
      TEARINGDOWN: "Tearing down",
      BLOCKED: "Blocked",
      ERROR: "Error",
    },
    drift: {
      NOT_DEPLOYED: "Not deployed, nothing to compare yet",
      CLEAN: "Matches the saved configuration",
      DRIFTED: "Drifted",
      SCAN_FAILED: "Not checked: the last scan could not run",
    },
    issue: {
      missingCapability: (tool: string, capability: string) =>
        `${tool} needs ${capability}, but no enabled tool provides it.`,
      missingAnyOf: (tool: string, options: string) =>
        `${tool} needs at least one of: ${options}.`,
      versionMismatch: (tool: string, others: string) =>
        `Incompatible versions: ${tool} with ${others}.`,
      conflict: (tools: readonly string[], subject: string) =>
        `${tools.join(" and ")} cannot be enabled together (${subject}).`,
      ambiguousProvider: (capability: string, tools: string) =>
        `Several tools provide ${capability}: ${tools}. Choose one.`,
      cyclicDependency:
        "The tools' capability declarations form a dependency cycle.",
      cloudMismatch: (tool: string, runsOn: string, projectCloud: string) =>
        `${tool} only runs on ${runsOn}, but the project uses ${projectCloud}.`,
      recommendedMissing: (tool: string, capability: string) =>
        `${tool} works better with ${capability}. Optional.`,
    },
  },
});
