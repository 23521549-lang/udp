import { describe, expect, it } from "vitest";
import { rebaseScheduleOf } from "../src/build.js";

/** [Plan #61 QĐ-13] Lịch rebase: tất định, trong 01:00–06:59 UTC, phút khác 0; ghim Dockerfile ⇒ không có lịch */
describe("rebaseScheduleOf", () => {
  it("tất định theo slug, đúng khung giờ, cron khớp giờ và phút", () => {
    const a = rebaseScheduleOf({ strategy: "auto" }, "checkout-service");
    expect(
      rebaseScheduleOf({ strategy: "buildpacks" }, "checkout-service"),
    ).toEqual(a);
    expect(a).not.toBeNull();
    const slugs = Array.from({ length: 200 }, (_, i) => `project-${String(i)}`);
    const schedules = slugs.map((s) =>
      rebaseScheduleOf({ strategy: "auto" }, s),
    );
    for (const s of schedules) {
      expect(s?.hour).toBeGreaterThanOrEqual(1);
      expect(s?.hour).toBeLessThanOrEqual(6);
      expect(s?.minute).toBeGreaterThanOrEqual(1);
      expect(s?.minute).toBeLessThanOrEqual(59);
      expect(s?.cron).toBe(`${String(s?.minute)} ${String(s?.hour)} * * *`);
    }
    // Rải tải: 200 project không dồn vào vài giờ chạy
    expect(new Set(schedules.map((s) => s?.cron)).size).toBeGreaterThan(100);
    expect(new Set(schedules.map((s) => s?.hour)).size).toBe(6);
  });

  it("ghim Dockerfile ⇒ không rebase (chỉ image Buildpacks rebase được)", () => {
    expect(rebaseScheduleOf({ strategy: "dockerfile" }, "web")).toBeNull();
  });
});
