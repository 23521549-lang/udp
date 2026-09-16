import type { SessionRow } from "../rollout-session/types.js";

/**
 * Hợp đồng của một chiến lược rollout (§7.2). Reconciler chỉ hỏi "bậc kế tiếp
 * là bao nhiêu" và "tới đâu là xong" — chiến lược nói traffic đi TỪ đâu TỚI đâu;
 * việc "đo và quyết" ở `decision.ts`, việc "áp lên đâu" ở executor.
 */
export const FULL_PERCENT = 100;

export interface RolloutStrategy {
  readonly name: SessionRow["strategy"];
  /** Bậc kế tiếp từ phần trăm hiện tại, chặn ở 100 */
  nextPercent(current: number, stepPercent: number): number;
  /** Tới đây là xong — event `COMPLETE`, không phải `PROMOTE` (§7.1) */
  isComplete(percent: number): boolean;
}

export type StrategyFor = (
  session: Pick<SessionRow, "strategy">,
) => RolloutStrategy | undefined;
