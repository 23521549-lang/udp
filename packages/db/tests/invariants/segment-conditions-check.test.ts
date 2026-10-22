import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openClient } from "../helpers/db.js";

/**
 * [v4.6] `segments_conditions_shape` — hình VÀ kiểu phần tử của
 * `Segment.conditions` giữ ở tầng database. Builder snapshot đọc chặt: một segment
 * sai hình làm hỏng snapshot của CẢ project (mọi lần ghi, `/sdk/config`, kill-switch
 * của Service 3 — I30), nên lỗi phải bị chặn lúc GHI.
 *
 * Mỗi ca chèn thật trong một transaction rồi lùi — không để lại gì.
 */

let client: Client;

beforeAll(async () => {
  client = await openClient();
});

afterAll(async () => {
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
  await client?.end();
});

async function insertCode(conditions: string): Promise<string | undefined> {
  await client.query("BEGIN");
  try {
    await client.query(
      `INSERT INTO segments (id, project_id, name, conditions, updated_at)
       VALUES (gen_random_uuid(), (SELECT id FROM projects ORDER BY created_at LIMIT 1),
               'check-' || gen_random_uuid()::text, $1::jsonb, now())`,
      [conditions],
    );
    return undefined;
  } catch (err: unknown) {
    return (err as { code?: string }).code;
  } finally {
    await client.query("ROLLBACK");
  }
}

describe("segments_conditions_shape", () => {
  it("nhận hình chốt { all: object[], userIds: string[] }", async () => {
    expect(
      await insertCode(
        '{"all":[{"attribute":"plan","operator":"eq","value":"pro"}],"userIds":["u1"]}',
      ),
    ).toBeUndefined();
    expect(await insertCode('{"all":[],"userIds":[]}')).toBeUndefined();
  });

  it.each([
    ["mảng (hình cũ)", "[]"],
    ["vô hướng — không được ném 22023 thay vì vi phạm CHECK", "5"],
    ["thiếu userIds", '{"all":[]}'],
    ["khoá thứ ba", '{"all":[],"userIds":[],"extra":1}'],
    ["userIds không phải chuỗi", '{"all":[],"userIds":[123]}'],
    ["điều kiện không phải object", '{"all":["plan"],"userIds":[]}'],
  ])("từ chối %s ⇒ 23514", async (_label, conditions) => {
    expect(await insertCode(conditions)).toBe("23514");
  });
});
