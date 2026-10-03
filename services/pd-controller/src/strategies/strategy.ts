import type { SessionRow } from "../rollout-session/types.js";

/**
 * Hợp đồng của một chiến lược rollout (§7.2). Reconciler chỉ hỏi "bậc kế tiếp
 * là bao nhiêu", "tới đâu là xong", "được tự quyết không" và "promote tay nghĩa là
 * gì" — chiến lược nói traffic đi TỪ đâu TỚI đâu; việc "đo và quyết" ở
 * `decision.ts`, việc "áp lên đâu" ở executor.
 */
export const FULL_PERCENT = 100;

export interface RolloutStrategy {
  readonly name: SessionRow["strategy"];
  /** Bậc kế tiếp từ phần trăm hiện tại, chặn ở 100 */
  nextPercent(current: number, stepPercent: number): number;
  /** Tới đây là xong — event `COMPLETE`, không phải `PROMOTE` (§7.1) */
  isComplete(percent: number): boolean;
  /**
   * [v4.11, Plan #46] Phân tích được TỰ promote/rollback không (§7.2 cột "Auto-rollback?"). Chỉ
   * canary so sánh nhân quả được — hai nhóm là mẫu ngẫu nhiên của cùng quần thể. Không tự quyết
   * thì mỗi nhịp vẫn đo và ghi HOLD kèm số đo cho người đọc.
   */
  readonly autoDecide: boolean;
  /**
   * [v4.11, Plan #46] Ý định PROMOTE nghĩa là gì: `ramp` = lên 100% của rule (canary);
   * `default-variant` = đổi variant mặc định của environment sang variant mới rồi đóng (§7.2
   * ATTRIBUTE_SPLIT "promote = đổi default variant").
   */
  readonly finish: "ramp" | "default-variant";
  /** [v4.11, Plan #46] Loại rule chiến lược này không nhận ⇒ lý do HOLD; nhận thì `undefined` */
  ruleIssue(ruleType: string): string | undefined;
}

export type StrategyFor = (
  session: Pick<SessionRow, "strategy">,
) => RolloutStrategy | undefined;
