import { round2 } from "../../core/decimal.js";
import { FULL_PERCENT, type RolloutStrategy } from "../strategy.js";

/**
 * Canary Release (§7.2) — chiến lược DUY NHẤT có auto-rollback: hai nhóm là mẫu
 * ngẫu nhiên của cùng quần thể, nên chênh lệch error rate quy được cho nhánh
 * (§6.6 "Ngữ nghĩa attribution").
 */
export const canaryStrategy: RolloutStrategy = {
  name: "CANARY",
  nextPercent: (current, stepPercent) =>
    Math.min(round2(current + stepPercent), FULL_PERCENT),
  isComplete: (percent) => percent >= FULL_PERCENT,
};
