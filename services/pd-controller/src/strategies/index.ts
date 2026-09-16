import type { SessionRow } from "../rollout-session/types.js";
import { canaryStrategy } from "./canary/canary.strategy.js";
import type { RolloutStrategy, StrategyFor } from "./strategy.js";

/**
 * Registry chiến lược. Không có trong đây ⇒ reconciler HOLD với lý do rõ, không
 * đoán. ATTRIBUTE_SPLIT và BLUE_GREEN của FLAG_LEVEL chỉ có đường tay (§7.2) và
 * cần endpoint đổi default variant chưa có — ngày dựng chúng thì thêm vào đây,
 * không thêm `if (strategy === ...)` vào reconciler.
 */
const REGISTRY: Partial<Record<SessionRow["strategy"], RolloutStrategy>> = {
  CANARY: canaryStrategy,
};

export const strategyFor: StrategyFor = (session) => REGISTRY[session.strategy];

export { FULL_PERCENT } from "./strategy.js";
export type { RolloutStrategy, StrategyFor } from "./strategy.js";
