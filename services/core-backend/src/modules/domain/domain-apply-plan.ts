import type { DomainAdapter, DomainToolConfig } from "@udp/adapter-core";
import type { CapabilityId } from "@udp/shared-types";
import {
  adapterKey,
  validateAndOrder,
  type ProviderPreference,
} from "../capability/capability.resolver.js";

/**
 * Kế hoạch áp cấu hình domain cho project ĐÃ triển khai (§8.2, Plan #30 P1) — THUẦN: từ
 * trạng thái hiện tại (đang chạy trên cluster) và trạng thái đích (đã qua validator) ra
 * đúng các thao tác, theo đúng thứ tự.
 *
 * | CASE §8.2 | Thao tác | Thứ tự |
 * | --- | --- | --- |
 * | 1 bật | `enable` | bậc của đồ thị ĐÍCH |
 * | 3 đổi tool | `switch` (deploy mới → healthcheck → rebind → báo consumer → teardown cũ) | bậc ĐÍCH |
 * | 4 đổi cấu hình | `reconfigure` | bậc ĐÍCH |
 * | 5 đổi preference | `rebind` theo capability | sau mọi deploy |
 * | 2 tắt | `disable` | NGƯỢC bậc của đồ thị HIỆN TẠI |
 *
 * Tắt đi SAU cùng: một consumer vừa được rebind sang provider mới không được chứng kiến
 * provider cũ biến mất trước khi nó nghe tin (§8.2 "rebind trước teardown").
 */

export interface DomainState {
  domainType: string;
  adapter: DomainAdapter;
  config: DomainToolConfig;
}

export type DomainOp =
  | { kind: "enable"; target: DomainState }
  | { kind: "reconfigure"; target: DomainState }
  | { kind: "switch"; from: DomainState; target: DomainState }
  | { kind: "disable"; from: DomainState };

export interface ApplyPlan {
  /** enable / switch / reconfigure, theo bậc của đồ thị đích; cùng bậc chạy song song */
  deployTiers: DomainOp[][];
  /** disable, ngược bậc của đồ thị hiện tại */
  disables: DomainOp[];
  /** Capability đổi provider mà không do bật/đổi tool (CASE 5) — cần rebind + báo consumer */
  rebinds: CapabilityId[];
  /** Provider đã chọn cho từng capability ở trạng thái ĐÍCH */
  chosen: Record<string, string>;
  /** Bậc của đồ thị ĐÍCH (khoá adapter) — thứ tự báo tin cho consumer */
  order: string[][];
}

/** So cấu hình theo NỘI DUNG — thứ tự khoá khác nhau không phải một lần đổi cấu hình */
function canonical(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(canonical);
  return Object.fromEntries(
    Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => [k, canonical(v)]),
  );
}
const sameConfig = (a: DomainToolConfig, b: DomainToolConfig): boolean =>
  JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));

function ordered(
  states: readonly DomainState[],
  prefs: readonly ProviderPreference[],
): { tiers: string[][]; chosen: Record<string, string> } {
  const result = validateAndOrder(
    states.map((s) => ({
      domainType: s.adapter.domainType,
      toolId: s.adapter.toolId,
      capabilities: s.adapter.capabilities,
    })),
    prefs,
  );
  if (!result.valid || result.order === null) {
    // Cả hai trạng thái đã qua validator khi được lưu; vỡ ở đây là dữ liệu hỏng
    throw new Error(
      `tổ hợp domain không hợp lệ: ${String(result.errors[0]?.code)}`,
    );
  }
  return { tiers: result.order, chosen: result.chosen };
}

export function planDomainApply(args: {
  current: readonly DomainState[];
  currentPreferences: readonly ProviderPreference[];
  target: readonly DomainState[];
  targetPreferences: readonly ProviderPreference[];
}): ApplyPlan {
  const byType = (xs: readonly DomainState[]) =>
    new Map(xs.map((x) => [x.domainType, x]));
  const current = byType(args.current);
  const target = byType(args.target);

  const opsByKey = new Map<string, DomainOp>();
  for (const t of args.target) {
    const c = current.get(t.domainType);
    const key = adapterKey(t.adapter);
    if (c === undefined) {
      opsByKey.set(key, { kind: "enable", target: t });
    } else if (c.adapter.toolId !== t.adapter.toolId) {
      opsByKey.set(key, { kind: "switch", from: c, target: t });
    } else if (!sameConfig(c.config, t.config)) {
      opsByKey.set(key, { kind: "reconfigure", target: t });
    }
  }

  const targetOrder = ordered(args.target, args.targetPreferences);
  const deployTiers = targetOrder.tiers
    .map((tier) => tier.flatMap((key) => opsByKey.get(key) ?? []))
    .filter((tier) => tier.length > 0);

  const currentOrder = ordered(args.current, args.currentPreferences);
  const currentByKey = new Map(
    args.current.map((c) => [adapterKey(c.adapter), c]),
  );
  const disables = [...currentOrder.tiers]
    .reverse()
    .flat()
    .flatMap((key) => {
      const c = currentByKey.get(key);
      return c !== undefined && !target.has(c.domainType)
        ? [{ kind: "disable" as const, from: c }]
        : [];
    });

  // CASE 5: provider đổi mà cả hai tool đều không bị bật mới hay đổi trong lượt này
  const touched = new Set(
    [...opsByKey.values()].flatMap((op) =>
      op.kind === "enable" || op.kind === "switch"
        ? [adapterKey(op.target.adapter)]
        : [],
    ),
  );
  const rebinds = Object.entries(targetOrder.chosen)
    .filter(
      ([cap, provider]) =>
        currentOrder.chosen[cap] !== undefined &&
        currentOrder.chosen[cap] !== provider &&
        !touched.has(provider),
    )
    .map(([cap]) => cap as CapabilityId)
    .sort();

  return {
    deployTiers,
    disables,
    rebinds,
    chosen: targetOrder.chosen,
    order: targetOrder.tiers,
  };
}
