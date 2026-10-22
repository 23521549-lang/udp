import { describe, expect, it } from "vitest";
import {
  formatRolloutIntentNotice,
  parseRolloutIntentNotice,
} from "../src/rollout-intent.js";

describe("notice rollout_intent", () => {
  const sessionId = "0190a1b2-c3d4-4e5f-8a6b-7c8d9e0f1a2b";

  it("hai đầu dùng chung một cặp hàm — đi một vòng không mất gì", () => {
    expect(
      parseRolloutIntentNotice(formatRolloutIntentNotice({ sessionId })),
    ).toEqual({ sessionId });
  });

  it.each([
    ["không phải JSON", "xin chào"],
    ["thiếu trường", "{}"],
    ["không phải uuid", JSON.stringify({ sessionId: "abc" })],
    ["null", "null"],
  ])("%s ⇒ null, không ném", (_label, payload) => {
    expect(parseRolloutIntentNotice(payload)).toBeNull();
  });

  it("trường thừa bị bỏ, không lọt ra ngoài", () => {
    expect(
      parseRolloutIntentNotice(JSON.stringify({ sessionId, drop: "table" })),
    ).toEqual({ sessionId });
  });
});
