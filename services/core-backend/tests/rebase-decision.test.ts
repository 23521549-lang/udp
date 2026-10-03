import { describe, expect, it } from "vitest";
import { decideRebase } from "../src/modules/cicd/rebase-decision.js";

/**
 * [Plan #61 QĐ-13] UDP quyết lượt rebase theo lịch: chỉ deploy khi production đang chạy ĐÚNG commit đó (thành công) với
 * digest khác — không bao giờ đè một lần rollback có chủ đích, một lần deploy đang chờ duyệt hay đang chạy.
 */
const D1 = `sha256:${"1".repeat(64)}`;
const D2 = `sha256:${"2".repeat(64)}`;
const IMAGE = "ghcr.io/acme/web";
const COMMIT = "0123456789abcdef0123456789abcdef01234567";
const OTHER = "89abcdef0123456789abcdef0123456789abcdef";
const rebased = `${IMAGE}:${COMMIT}@${D2}`;
const success = (imageRef: string | null) => ({
  deploymentId: "dep-1",
  eventType: "DEPLOY_SUCCESS",
  imageRef,
});

describe("decideRebase", () => {
  it("production chạy cùng commit, digest cũ ⇒ deploy", () => {
    expect(decideRebase(success(`${IMAGE}:${COMMIT}@${D1}`), rebased)).toEqual({
      action: "deploy",
    });
  });

  it("deploy cũ trước Plan #61 (chỉ tag, không digest) cùng commit ⇒ deploy", () => {
    expect(decideRebase(success(`${IMAGE}:${COMMIT}`), rebased).action).toBe(
      "deploy",
    );
  });

  it("đã chạy đúng image vừa rebase (run image không đổi) ⇒ unchanged, không ghi gì", () => {
    expect(decideRebase(success(rebased), rebased)).toEqual({
      action: "unchanged",
      deploymentId: "dep-1",
    });
  });

  it("production chạy commit khác (rollback có chủ đích, đầu main chưa lên) ⇒ skipped OTHER_IMAGE", () => {
    expect(decideRebase(success(`${IMAGE}:${OTHER}@${D1}`), rebased)).toEqual({
      action: "skipped",
      deploymentId: "dep-1",
      reason: "OTHER_IMAGE",
    });
  });

  it("rollout SERVICE_LEVEL không ghi image ⇒ không khẳng định được ⇒ skipped OTHER_IMAGE", () => {
    expect(decideRebase(success(null), rebased)).toMatchObject({
      action: "skipped",
      reason: "OTHER_IMAGE",
    });
  });

  it("lần mới nhất đang chờ duyệt, đang chạy, hỏng hay đã khôi phục ⇒ skipped NOT_SETTLED", () => {
    for (const eventType of [
      "DEPLOY_PENDING",
      "DEPLOY_START",
      "DEPLOY_FAILURE",
      "ROLLBACK",
    ]) {
      expect(
        decideRebase(
          {
            deploymentId: "dep-2",
            eventType,
            imageRef: `${IMAGE}:${COMMIT}@${D1}`,
          },
          rebased,
        ),
        eventType,
      ).toEqual({
        action: "skipped",
        deploymentId: "dep-2",
        reason: "NOT_SETTLED",
      });
    }
  });

  it("production chưa deploy lần nào ⇒ skipped NOT_DEPLOYED (rebase không tạo lần deploy đầu tiên)", () => {
    expect(decideRebase(null, rebased)).toEqual({
      action: "skipped",
      deploymentId: null,
      reason: "NOT_DEPLOYED",
    });
  });
});
