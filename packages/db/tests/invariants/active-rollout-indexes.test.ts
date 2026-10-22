import { ACTIVE_ROLLOUT_STATUSES } from "@udp/config/constants";
import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openClient } from "../helpers/db.js";

/**
 * [v4.4] Hai partial index "một rollout sống" dùng ĐÚNG vị từ
 * `ACTIVE_ROLLOUT_STATUSES` — không import được hằng TypeScript vào SQL, nên đọc
 * định nghĩa index từ catalog và so. Thiếu một status (vd PAUSED, lỗi thật của
 * v3) là index cho tạo hai rollout trên cùng flag/target.
 */

let client: Client;

beforeAll(async () => {
  client = await openClient();
});

afterAll(async () => {
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
  await client?.end();
});

const statusesOf = (indexdef: string): string[] =>
  [...indexdef.matchAll(/'([A-Z_]+)'::"RolloutStatus"/g)]
    .map((m) => m[1] as string)
    .sort();

describe("idx_one_active_rollout_* — cùng vị từ 'đang sống'", () => {
  it.each([
    "idx_one_active_rollout_per_target",
    "idx_one_active_rollout_per_flag",
  ])("%s: UNIQUE, partial theo đúng ACTIVE_ROLLOUT_STATUSES", async (name) => {
    const { rows } = await client.query<{ indexdef: string }>(
      "SELECT indexdef FROM pg_indexes WHERE indexname = $1",
      [name],
    );
    const def = rows[0]?.indexdef ?? "";
    expect(def).toMatch(/^CREATE UNIQUE INDEX/);
    expect(statusesOf(def)).toEqual([...ACTIVE_ROLLOUT_STATUSES].sort());
  });

  it("per_flag khoá theo flag_env_config_id, bất kể workload", async () => {
    const { rows } = await client.query<{ indexdef: string }>(
      "SELECT indexdef FROM pg_indexes WHERE indexname = 'idx_one_active_rollout_per_flag'",
    );
    expect(rows[0]?.indexdef).toMatch(/\(flag_env_config_id\)/);
    expect(rows[0]?.indexdef).not.toMatch(/workload_name/);
  });
});
