import type {
  DomainCatalogEntryWire,
  DomainDriftWire,
  DomainValidationWire,
  ProjectDomainWire,
} from "@udp/shared-types/wire";
import { messagesOf } from "../../i18n";
import { domainLabelMessages } from "./domain-labels.messages";

/**
 * Nhãn của domain theo ngôn ngữ đang chọn (Plan #54) — hàm tra đọc ngôn ngữ lúc gọi, như `formatNumber`;
 * component gọi chúng đã theo dõi ngôn ngữ qua chữ của chính nó. Chữ ở `domain-labels.messages.ts`.
 */
const labels = () => messagesOf(domainLabelMessages);

export const tierLabel = (tier: DomainCatalogEntryWire["tier"]): string =>
  labels().tier[tier];

export const domainStatusLabel = (
  status: NonNullable<ProjectDomainWire["status"]>,
): string => labels().status[status];

export const driftLabel = (verdict: DomainDriftWire["verdict"]): string =>
  labels().drift[verdict];

type Issue =
  | DomainValidationWire["errors"][number]
  | DomainValidationWire["warnings"][number];

/**
 * Câu cho một vấn đề của validator. `nameOf` đổi khoá `<domain>:<tool>` thành tên đọc được
 * (`datadog (Monitoring)`); `subject`/`detail` giữ đúng nghĩa resolver trả về.
 */
export function issueText(
  issue: Issue,
  nameOf: (key: string) => string,
): string {
  const t = labels().issue;
  const d = issue.detail;
  switch (issue.code) {
    case "MISSING_CAPABILITY":
      return t.missingCapability(nameOf(issue.subject), d[0] ?? "?");
    case "MISSING_ANY_OF":
      return t.missingAnyOf(nameOf(issue.subject), d.join(", "));
    case "VERSION_MISMATCH":
      return t.versionMismatch(nameOf(issue.subject), d.map(nameOf).join(", "));
    case "CONFLICT":
      return t.conflict(d.map(nameOf), nameOf(issue.subject));
    case "AMBIGUOUS_PROVIDER":
      return t.ambiguousProvider(issue.subject, d.map(nameOf).join(", "));
    case "CYCLIC_DEPENDENCY":
      return t.cyclicDependency;
    case "CLOUD_MISMATCH":
      return t.cloudMismatch(nameOf(issue.subject), d[0] ?? "?", d[1] ?? "?");
    case "RECOMMENDED_MISSING":
      return t.recommendedMissing(nameOf(issue.subject), d[0] ?? "?");
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
