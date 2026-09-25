import type {
  DomainCatalogEntryWire,
  DomainDriftWire,
  DomainValidationWire,
  ProjectDomainWire,
} from "@udp/shared-types/wire";

/**
 * Chữ hiển thị của trang Domain (I37: mã ở máy chủ, câu ở Portal). `Record` theo đúng kiểu
 * dây: thêm một mã validator hay một trạng thái mà quên câu là lỗi biên dịch.
 */

export const TIER_LABEL: Record<DomainCatalogEntryWire["tier"], string> = {
  CORE: "Cốt lõi",
  STANDARD: "Tiêu chuẩn",
  ADVANCED: "Nâng cao",
};

export const STATUS_LABEL: Record<
  NonNullable<ProjectDomainWire["status"]>,
  string
> = {
  PENDING: "Chờ triển khai",
  DEPLOYING: "Đang triển khai",
  ACTIVE: "Đang chạy",
  SWITCHING: "Đang đổi tool",
  RECONFIGURING: "Đang cấu hình lại",
  TEARINGDOWN: "Đang gỡ",
  BLOCKED: "Bị chặn",
  ERROR: "Lỗi",
};

export const DRIFT_LABEL: Record<DomainDriftWire["verdict"], string> = {
  NOT_DEPLOYED: "Chưa triển khai, chưa có gì để trôi",
  CLEAN: "Khớp cấu hình mong muốn",
  DRIFTED: "Đã trôi khỏi cấu hình mong muốn",
  SCAN_FAILED: "Lần quét gần nhất không chạy được",
};

type Issue =
  | DomainValidationWire["errors"][number]
  | DomainValidationWire["warnings"][number];

/**
 * Câu cho một vấn đề của validator. `nameOf` đổi khoá `<domain>:<tool>` thành tên đọc được
 * (`datadog, Giám sát`); `subject`/`detail` giữ đúng nghĩa resolver trả về.
 */
export function issueText(
  issue: Issue,
  nameOf: (key: string) => string,
): string {
  const d = issue.detail;
  switch (issue.code) {
    case "MISSING_CAPABILITY":
      return `${nameOf(issue.subject)} cần ${d[0] ?? "?"}, nhưng chưa tool nào đang bật cung cấp nó.`;
    case "MISSING_ANY_OF":
      return `${nameOf(issue.subject)} cần ít nhất một trong: ${d.join(", ")}.`;
    case "VERSION_MISMATCH":
      return `Phiên bản không tương thích: ${nameOf(issue.subject)} với ${d.map(nameOf).join(", ")}.`;
    case "CONFLICT":
      return `Không bật đồng thời được ${d.map(nameOf).join(" và ")} (${nameOf(issue.subject)}).`;
    case "AMBIGUOUS_PROVIDER":
      return `Nhiều tool cùng cung cấp ${issue.subject}: ${d.map(nameOf).join(", ")}. Chọn một.`;
    case "CYCLIC_DEPENDENCY":
      return "Khai báo capability của các tool tạo thành vòng phụ thuộc.";
    case "RECOMMENDED_MISSING":
      return `${nameOf(issue.subject)} hoạt động tốt hơn khi có ${d[0] ?? "?"}. Không bắt buộc.`;
  }
}

/** `monitoring:datadog` ⇒ `datadog (Giám sát)` theo catalog; khoá lạ giữ nguyên */
export function toolNamer(
  catalog: readonly DomainCatalogEntryWire[],
): (key: string) => string {
  const names = new Map<string, string>();
  for (const entry of catalog) {
    for (const tool of entry.tools) {
      names.set(
        `${entry.domainType}:${tool.toolId}`.toLowerCase(),
        `${tool.toolId} (${entry.displayName})`,
      );
    }
  }
  return (key) => names.get(key.toLowerCase()) ?? key;
}
