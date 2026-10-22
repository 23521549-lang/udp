import type { SessionRow } from "../rollout-session/types.js";
import { attributeSplitStrategy } from "./attribute-split/attribute-split.strategy.js";
import { canaryStrategy } from "./canary/canary.strategy.js";
import type { RolloutStrategy, StrategyFor } from "./strategy.js";

/**
 * Registry chiến lược. Không có trong đây ⇒ reconciler HOLD với lý do rõ, không
 * đoán. Khác biệt giữa các chiến lược nằm ở thuộc tính của chúng (`autoDecide`,
 * `finish`, `ruleIssue`) — không thêm `if (strategy === ...)` vào reconciler.
 * BLUE_GREEN ở FLAG_LEVEL "không áp dụng" (§7.2); Service 1 từ chối lúc tạo.
 */
const REGISTRY: Partial<Record<SessionRow["strategy"], RolloutStrategy>> = {
  CANARY: canaryStrategy,
  ATTRIBUTE_SPLIT: attributeSplitStrategy,
};

export const strategyFor: StrategyFor = (session) => REGISTRY[session.strategy];

export { FULL_PERCENT } from "./strategy.js";
export type { RolloutStrategy, StrategyFor } from "./strategy.js";
