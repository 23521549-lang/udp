import type { DomainTargetState } from "@udp/shared-types/domain-api";
import type {
  DomainCatalogEntryWire,
  DomainToolWire,
  ProjectDomainsResponseWire,
} from "@udp/shared-types/wire";

/**
 * Bản nháp cấu hình domain trên trang (§10.7 `draftDomains`) — THUẦN. Bản nháp giữ cả
 * domain đang tắt (tool và cấu hình đã chọn), còn thứ gửi đi là TRẠNG THÁI ĐÍCH: chỉ domain
 * bật (Plan #27 QĐ-4). Hai thứ khác nhau đó là lý do có `targetOf`.
 */

export interface DraftEntry {
  enabled: boolean;
  toolId: string | null;
  config: Record<string, unknown>;
}

export interface DomainDraft {
  entries: Record<string, DraftEntry>;
  preferences: DomainTargetState["preferences"];
}

/** Giá trị mặc định mà adapter khai — form mở ra đã đúng với tool vừa chọn */
export function defaultsOf(
  tool: DomainToolWire | undefined,
): Record<string, unknown> {
  if (tool === undefined || tool.config.kind === "json") return {};
  return Object.fromEntries(
    tool.config.fields.flatMap((f) =>
      f.default === undefined ? [] : [[f.key, f.default]],
    ),
  );
}

export function draftFrom(
  catalog: readonly DomainCatalogEntryWire[],
  saved: ProjectDomainsResponseWire,
): DomainDraft {
  const byType = new Map(saved.domains.map((d) => [d.domainType, d]));
  const entries: Record<string, DraftEntry> = {};
  for (const entry of catalog) {
    const row = byType.get(entry.domainType);
    const toolId = row?.selectedTool ?? entry.tools[0]?.toolId ?? null;
    const tool = entry.tools.find((t) => t.toolId === toolId);
    entries[entry.domainType] = {
      enabled: row?.isEnabled ?? false,
      toolId,
      config: row?.toolConfig ?? defaultsOf(tool),
    };
  }
  return { entries, preferences: saved.preferences };
}

export function targetOf(draft: DomainDraft): DomainTargetState {
  return {
    domains: Object.entries(draft.entries).flatMap(([domainType, e]) =>
      e.enabled && e.toolId !== null
        ? [{ domainType, toolId: e.toolId, config: e.config }]
        : [],
    ),
    preferences: draft.preferences,
  };
}

export const sameTarget = (a: DomainDraft, b: DomainDraft): boolean =>
  JSON.stringify(targetOf(a)) === JSON.stringify(targetOf(b));

function entryOf(draft: DomainDraft, domainType: string): DraftEntry {
  return (
    draft.entries[domainType] ?? { enabled: false, toolId: null, config: {} }
  );
}

/** Đổi tool thì cấu hình về mặc định của tool MỚI — cấu hình của tool cũ không hợp lệ với nó */
export function chooseTool(
  draft: DomainDraft,
  entry: DomainCatalogEntryWire,
  toolId: string,
): DomainDraft {
  const current = entryOf(draft, entry.domainType);
  const tool = entry.tools.find((t) => t.toolId === toolId);
  return {
    ...draft,
    entries: {
      ...draft.entries,
      [entry.domainType]: {
        ...current,
        toolId,
        config: current.toolId === toolId ? current.config : defaultsOf(tool),
      },
    },
  };
}

export function setEnabled(
  draft: DomainDraft,
  domainType: string,
  enabled: boolean,
): DomainDraft {
  return {
    ...draft,
    entries: {
      ...draft.entries,
      [domainType]: { ...entryOf(draft, domainType), enabled },
    },
  };
}

export function setConfig(
  draft: DomainDraft,
  domainType: string,
  config: Record<string, unknown>,
): DomainDraft {
  return {
    ...draft,
    entries: {
      ...draft.entries,
      [domainType]: { ...entryOf(draft, domainType), config },
    },
  };
}

/** Nút "Bật …" của lỗi MISSING_CAPABILITY (§5.3): bật đúng domain với đúng tool gợi ý */
export function enableSuggested(
  draft: DomainDraft,
  catalog: readonly DomainCatalogEntryWire[],
  domainType: string,
  toolId: string,
): DomainDraft {
  const entry = catalog.find((c) => c.domainType === domainType);
  if (entry === undefined) return draft;
  return setEnabled(chooseTool(draft, entry, toolId), domainType, true);
}

/** Một thay đổi của trạng thái đích so với bản đang chạy — hộp xác nhận kê từng dòng */
export type DomainChange =
  | { kind: "enable"; domainType: string; toolId: string }
  | { kind: "disable"; domainType: string; toolId: string }
  | { kind: "switch"; domainType: string; from: string; to: string }
  | { kind: "config"; domainType: string; toolId: string };

/**
 * Khác biệt giữa hai trạng thái ĐÍCH (chỉ domain bật đếm — domain tắt mang cấu hình cũ không làm gì
 * cluster). Thứ tự theo catalog của bản nháp, để hộp xác nhận đọc cùng thứ tự với trang.
 */
export function changesOf(
  running: DomainDraft,
  next: DomainDraft,
): DomainChange[] {
  const before = new Map(
    targetOf(running).domains.map((d) => [d.domainType, d]),
  );
  const after = new Map(targetOf(next).domains.map((d) => [d.domainType, d]));
  const out: DomainChange[] = [];
  for (const domainType of Object.keys(next.entries)) {
    const a = before.get(domainType);
    const b = after.get(domainType);
    if (a === undefined && b !== undefined) {
      out.push({ kind: "enable", domainType, toolId: b.toolId });
    } else if (a !== undefined && b === undefined) {
      out.push({ kind: "disable", domainType, toolId: a.toolId });
    } else if (a !== undefined && b !== undefined) {
      if (a.toolId !== b.toolId) {
        out.push({ kind: "switch", domainType, from: a.toolId, to: b.toolId });
      } else if (JSON.stringify(a.config) !== JSON.stringify(b.config)) {
        out.push({ kind: "config", domainType, toolId: b.toolId });
      }
    }
  }
  return out;
}

/** Dropdown của AMBIGUOUS_PROVIDER: một lựa chọn cho mỗi capability */
export function choosePreference(
  draft: DomainDraft,
  capabilityId: DomainTargetState["preferences"][number]["capabilityId"],
  providerToolId: string,
): DomainDraft {
  return {
    ...draft,
    preferences: [
      ...draft.preferences.filter((p) => p.capabilityId !== capabilityId),
      { capabilityId, providerToolId },
    ],
  };
}
