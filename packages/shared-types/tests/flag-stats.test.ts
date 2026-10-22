import { SDK_STATS } from "@udp/config/constants";
import { describe, expect, it } from "vitest";
import {
  flagStatsQueryFields,
  flagStatsQueryRefine,
  flagStatsSummarySchema,
  hourFloor,
  staleFlagsQuerySchema,
  tzSchema,
} from "../src/flag-stats.js";

describe("tzSchema — chỉ UTC hoặc Area/Location", () => {
  it.each([
    "UTC",
    "Asia/Ho_Chi_Minh",
    "America/Argentina/Buenos_Aires",
    "America/Port-au-Prince",
    "Etc/GMT+7",
  ])("nhận %s", (tz) => {
    expect(tzSchema.safeParse(tz).success).toBe(true);
  });

  it.each([
    // POSIX: Postgres hiểu thành UTC−7
    "UTC+7",
    "../x",
    "Asia/../x",
    "asia ho chi minh",
    "",
    `Asia/${"x".repeat(SDK_STATS.query.tzMaxLength)}`,
  ])("từ chối %j", (tz) => {
    expect(tzSchema.safeParse(tz).success).toBe(false);
  });
});

describe("hourFloor", () => {
  it("về đầu giờ UTC, giữ nguyên mốc đã tròn giờ", () => {
    expect(hourFloor(new Date("2026-09-22T10:59:59.999Z")).toISOString()).toBe(
      "2026-09-22T10:00:00.000Z",
    );
    expect(hourFloor(new Date("2026-09-22T10:00:00.000Z")).toISOString()).toBe(
      "2026-09-22T10:00:00.000Z",
    );
  });
});

describe("query stats theo flag", () => {
  const schema = flagStatsQueryFields
    .strict()
    .superRefine(flagStatsQueryRefine);

  it("mặc định từ hằng số, số trong query string được ép kiểu", () => {
    expect(schema.parse({})).toEqual({
      days: SDK_STATS.query.defaultDays,
      granularity: "day",
      tz: "UTC",
    });
    expect(schema.parse({ days: "3", granularity: "hour" }).days).toBe(3);
  });

  it("granularity=hour chỉ khi days ≤ maxHourlyDays", () => {
    const hourly = (days: number) =>
      schema.safeParse({ days, granularity: "hour" }).success;
    expect(hourly(SDK_STATS.query.maxHourlyDays)).toBe(true);
    expect(hourly(SDK_STATS.query.maxHourlyDays + 1)).toBe(false);
  });

  it("days ngoài 1..maxDays bị từ chối", () => {
    expect(schema.safeParse({ days: 0 }).success).toBe(false);
    expect(
      schema.safeParse({ days: SDK_STATS.query.maxDays + 1 }).success,
    ).toBe(false);
  });
});

describe("query Cleanup Center", () => {
  it("mặc định limit/offset; limit quá trần hoặc category lạ bị từ chối", () => {
    expect(staleFlagsQuerySchema.parse({})).toEqual({
      limit: SDK_STATS.query.staleList.defaultLimit,
      offset: 0,
    });
    expect(
      staleFlagsQuerySchema.safeParse({
        limit: SDK_STATS.query.staleList.maxLimit + 1,
      }).success,
    ).toBe(false);
    expect(staleFlagsQuerySchema.safeParse({ category: "OLD" }).success).toBe(
      false,
    );
  });
});

describe("flagStatsSummarySchema", () => {
  it("daily14 phải đủ sparklineDays điểm", () => {
    const item = (daily14: number[]) => ({
      items: [
        {
          flagId: "0190a1b2-c3d4-4e5f-8a6b-7c8d9e0f1a2b",
          evalCount7d: 0,
          daily14,
        },
      ],
    });
    const full = Array.from({ length: SDK_STATS.query.sparklineDays }, () => 0);
    expect(flagStatsSummarySchema.safeParse(item(full)).success).toBe(true);
    expect(flagStatsSummarySchema.safeParse(item(full.slice(1))).success).toBe(
      false,
    );
  });
});
