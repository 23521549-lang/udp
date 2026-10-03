import { describe, expect, it } from "vitest";
import {
  flaggerGatePath,
  flaggerGateToken,
  flaggerGateTokenMatches,
  isFlaggerGate,
} from "../src/flagger-gate.js";

/** Gate Flagger (Plan #51 QĐ-9): S1 ghi token vào Canary, S3 kiểm — cùng một hàm */

describe("flaggerGateToken", () => {
  const secret = "bi-mat-noi-bo-du-dai-0000000000";

  it("tất định theo (bí mật, session); khác session ⇒ khác token", () => {
    expect(flaggerGateToken(secret, "s-1")).toBe(
      flaggerGateToken(secret, "s-1"),
    );
    expect(flaggerGateToken(secret, "s-1")).not.toBe(
      flaggerGateToken(secret, "s-2"),
    );
    expect(flaggerGateToken(secret, "s-1")).toMatch(/^[0-9a-f]{64}$/);
  });

  it("token của session này không mở gate của session khác; chuỗi sai độ dài không ném", () => {
    const token = flaggerGateToken(secret, "s-1");
    expect(flaggerGateTokenMatches(secret, "s-1", token)).toBe(true);
    expect(flaggerGateTokenMatches(secret, "s-2", token)).toBe(false);
    expect(flaggerGateTokenMatches(secret, "s-1", "ngan")).toBe(false);
    expect(flaggerGateTokenMatches("bi-mat-khac", "s-1", token)).toBe(false);
  });

  it("đường gate và tập gate đóng", () => {
    expect(flaggerGatePath("s-1", "rollback")).toBe(
      "/webhooks/flagger/s-1/rollback",
    );
    expect(isFlaggerGate("confirm-promotion")).toBe(true);
    expect(isFlaggerGate("pre-rollout")).toBe(false);
  });
});
