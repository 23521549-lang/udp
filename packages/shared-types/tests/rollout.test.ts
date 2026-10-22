import { describe, expect, it } from "vitest";
import { canaryPairOf, trackResultSchema } from "../src/rollout.js";

const A = "00000000-0000-4000-8000-00000000000a";
const B = "00000000-0000-4000-8000-00000000000b";
const split = (a: number) => ({
  kind: "distribution" as const,
  weights: [
    { variantId: A, weight: a },
    { variantId: B, weight: 100_000 - a },
  ],
});

describe("canaryPairOf — MỘT định nghĩa 'rule ramp được' cho S1 và S3 [v4.4]", () => {
  it("giữ đúng thứ tự weights của rule (thứ tự cộng dồn của pickVariant, I1)", () => {
    const pair = canaryPairOf(split(30_000), B);
    expect(pair).toMatchObject({
      kind: "ok",
      target: { variantId: B, weight: 70_000 },
      other: { variantId: A, weight: 30_000 },
      weights: [
        { variantId: A, weight: 30_000 },
        { variantId: B, weight: 70_000 },
      ],
      targetPercent: 70,
    });
  });

  it("baseline làm tròn XUỐNG tới 0.01% — rollback không bao giờ tăng phơi nhiễm", () => {
    const percent = (w: number) => {
      const pair = canaryPairOf(split(w), A);
      if (pair.kind !== "ok") throw new Error(pair.reason);
      return pair.targetPercent;
    };
    expect(percent(33_333)).toBe(33.33);
    expect(percent(5)).toBe(0);
    expect(percent(15)).toBe(0.01);
    expect(percent(99_995)).toBe(99.99);
    expect(percent(0)).toBe(0);
  });

  it("từ chối: serve thẳng một variant, khác hai nhánh, variant lạ, target đã 100%", () => {
    expect(canaryPairOf({ kind: "variant", variantId: A }, A).kind).toBe(
      "invalid",
    );
    expect(
      canaryPairOf(
        {
          kind: "distribution",
          weights: [
            { variantId: A, weight: 50_000 },
            { variantId: B, weight: 25_000 },
            { variantId: "c", weight: 25_000 },
          ],
        },
        A,
      ),
    ).toMatchObject({
      kind: "invalid",
      reason: expect.stringMatching(/hai nhánh/),
    });
    expect(canaryPairOf(split(50_000), "khac").kind).toBe("invalid");
    expect(canaryPairOf(split(100_000), A)).toMatchObject({
      kind: "invalid",
      reason: expect.stringMatching(/100%/),
    });
  });
});

describe("trackResultSchema — body 200 của track/untrack, một schema cho S1, S2, S3", () => {
  it("nhận cả hai hình; từ chối body thiếu trường", () => {
    expect(
      trackResultSchema.safeParse({
        flagKey: "f",
        environmentId: "e",
        tracked: true,
        changed: false,
        skipped: "already-tracked",
      }).success,
    ).toBe(true);
    expect(
      trackResultSchema.safeParse({
        tracked: false,
        changed: false,
        skipped: "not-found",
      }).success,
    ).toBe(true);
    expect(trackResultSchema.safeParse({ changed: true }).success).toBe(false);
  });
});
