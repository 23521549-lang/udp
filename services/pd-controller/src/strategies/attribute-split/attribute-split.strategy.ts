import { FULL_PERCENT, type RolloutStrategy } from "../strategy.js";

/**
 * Attribute Split (§7.2, v2 gọi là "A/B Testing") ở FLAG_LEVEL — CHỈ định tuyến, không suy luận
 * thống kê (§16). Rule `ATTRIBUTE_BASED`/`SEGMENT` phân phối hai variant; bậc duy nhất đưa nhóm khớp
 * thuộc tính sang 100% variant mới. Hai nhóm khác nhau về bản chất — lỗi cao hơn ở nhóm VN có thể do
 * mạng ở VN — nên KHÔNG tự quyết: đo và hiện, người dùng promote (đổi variant mặc định) hay rollback.
 */
export const attributeSplitStrategy: RolloutStrategy = {
  name: "ATTRIBUTE_SPLIT",
  nextPercent: () => FULL_PERCENT,
  // Lên 100% của RULE chưa phải xong — xong là khi variant mặc định đổi (ý định PROMOTE)
  isComplete: () => false,
  autoDecide: false,
  finish: "default-variant",
  ruleIssue: (ruleType) =>
    ruleType === "ATTRIBUTE_BASED" || ruleType === "SEGMENT"
      ? undefined
      : `ATTRIBUTE_SPLIT cần rule ATTRIBUTE_BASED hoặc SEGMENT, rule này là ${ruleType} (§7.2)`,
};
