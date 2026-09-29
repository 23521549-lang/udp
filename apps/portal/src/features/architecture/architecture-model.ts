import type {
  ArchitectureToolWire,
  ArchitectureWire,
} from "@udp/shared-types/wire";
import type { Tone } from "../../components/StatusLabel";
import { messagesOf } from "../../i18n";
import { domainStatusLabel } from "../domain/domain-labels";
import { architectureMessages } from "./architecture.messages";

/**
 * [Plan #53] Mô hình của sơ đồ kiến trúc và lưới sức khoẻ — THUẦN, test được không cần DOM.
 * [Plan #54] Nhãn đọc theo ngôn ngữ LÚC GỌI (`messagesOf`), chữ ở `architecture.messages.tsx`.
 */

/**
 * Sức khoẻ của MỘT công cụ = trạng thái của domain cộng phán quyết drift (§10.6 "domain_status per
 * domain" — không có cột health riêng, D-P của Plan #45). Một bảng, dùng cho lưới ở Tổng quan, nút của
 * sơ đồ và trang Giám sát.
 */
export function toolHealth(tool: ArchitectureToolWire): {
  tone: Tone;
  label: string;
} {
  const copy = messagesOf(architectureMessages).health;
  switch (tool.status) {
    case null:
      return { tone: "unknown", label: copy.notDeployed };
    case "ERROR":
      return { tone: "error", label: domainStatusLabel("ERROR") };
    case "BLOCKED":
      return { tone: "warn", label: domainStatusLabel("BLOCKED") };
    case "ACTIVE":
      if (tool.drift.verdict === "DRIFTED") {
        return { tone: "warn", label: copy.drifted };
      }
      if (tool.drift.verdict === "SCAN_FAILED") {
        return { tone: "warn", label: copy.scanFailed };
      }
      return { tone: "ok", label: copy.healthy };
    default:
      return { tone: "running", label: domainStatusLabel(tool.status) };
  }
}

/** Mức nghiêm trọng để sắp: lỗi trước, rồi cảnh báo, đang chạy, không rõ, ổn */
const SEVERITY: Record<Tone, number> = {
  error: 0,
  warn: 1,
  running: 2,
  unknown: 3,
  ok: 4,
};

export const bySeverity = (a: ArchitectureToolWire, b: ArchitectureToolWire) =>
  SEVERITY[toolHealth(a).tone] - SEVERITY[toolHealth(b).tone];

/** Đếm theo tone — dòng tóm tắt "12 ổn, 1 lệch, 1 lỗi" */
export function healthSummary(
  tools: readonly ArchitectureToolWire[],
): Record<Tone, number> {
  const out: Record<Tone, number> = {
    ok: 0,
    running: 0,
    warn: 0,
    error: 0,
    unknown: 0,
  };
  for (const t of tools) out[toolHealth(t).tone] += 1;
  return out;
}

/**
 * Công cụ cấp cluster xếp theo BẬC của thứ tự deploy (cột trái deploy trước). Tool không có bậc (tổ
 * hợp không hợp lệ, tool đã gỡ khỏi registry) vào một cột cuối riêng.
 */
export function tiersOf(
  tools: readonly ArchitectureToolWire[],
): { tier: number | null; tools: ArchitectureToolWire[] }[] {
  const clusterTools = tools.filter((t) => t.scope !== "namespace");
  const tiers = [
    ...new Set(clusterTools.flatMap((t) => (t.tier === null ? [] : [t.tier]))),
  ].sort((a, b) => a - b);
  const out: { tier: number | null; tools: ArchitectureToolWire[] }[] =
    tiers.map((tier) => ({
      tier,
      tools: clusterTools.filter((t) => t.tier === tier),
    }));
  const loose = clusterTools.filter((t) => t.tier === null);
  if (loose.length > 0) out.push({ tier: null, tools: loose });
  return out;
}

/** Công cụ cấp namespace — cài vào MỖI environment */
export const namespaceTools = (
  tools: readonly ArchitectureToolWire[],
): ArchitectureToolWire[] => tools.filter((t) => t.scope === "namespace");

/** Tài nguyên theo loại cho một bước: `[["subnet", 3], ["vpc", 1]]` */
export function resourceKinds(
  a: ArchitectureWire,
  step: ArchitectureWire["resources"][number]["step"],
): [string, number][] {
  const count = new Map<string, number>();
  for (const r of a.resources) {
    if (r.step === step) count.set(r.kind, (count.get(r.kind) ?? 0) + 1);
  }
  return [...count.entries()].sort((x, y) => x[0].localeCompare(y[0]));
}

/** Quan hệ của một công cụ: nó cần gì từ ai, và ai cần nó */
export function relationsOf(
  a: ArchitectureWire,
  key: string,
): {
  needs: {
    capabilityId: string;
    tool: ArchitectureToolWire | undefined;
    key: string;
  }[];
  usedBy: {
    capabilityId: string;
    tool: ArchitectureToolWire | undefined;
    key: string;
  }[];
} {
  const byKey = new Map(a.tools.map((t) => [t.key, t]));
  return {
    needs: a.edges
      .filter((e) => e.from === key)
      .map((e) => ({
        capabilityId: e.capabilityId,
        key: e.to,
        tool: byKey.get(e.to),
      })),
    usedBy: a.edges
      .filter((e) => e.to === key)
      .map((e) => ({
        capabilityId: e.capabilityId,
        key: e.from,
        tool: byKey.get(e.from),
      })),
  };
}
