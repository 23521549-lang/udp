import { CHANGE_FEED } from "@udp/config/constants";
import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { inRollback, openClient } from "../helpers/db.js";

/**
 * Dọn `ConfigChangeLog` (§2.2) — quyền được cấp phải ĐÚNG bằng "xoá dòng quá hạn".
 *
 * `udp_s2` không có DELETE trên bảng (§1.2, I22); nó dọn qua hàm
 * `udp_prune_config_change_log` chạy bằng quyền owner. Một hàm như vậy chỉ an toàn
 * khi thân hàm tự giữ ranh giới: quá hạn mới xoá, theo lô, và retention không nằm
 * trong tay bên gọi. Quyền EXECUTE của hàm do I22 canh; file này canh HÀNH VI.
 *
 * Mọi thứ chạy trong transaction ROLLBACK: test không để lại dòng nào, và hàm xoá
 * gì trong đó cũng không tới được dữ liệu thật. Version dùng dải rất cao để không
 * đụng `(environment_id, config_version)` của dòng nào đang có.
 */

let client: Client;
let envId: string;

beforeAll(async () => {
  client = await openClient();
  const env = await client.query<{ id: string }>(
    `SELECT id FROM environments LIMIT 1`,
  );
  if (env.rows[0] === undefined) {
    throw new Error("Database chưa seed — chạy `pnpm db:seed` trước");
  }
  envId = env.rows[0].id;
});

afterAll(async () => {
  // Cùng lý do với i30-killswitch.test.ts: beforeAll ném thì client chưa gán
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
  await client?.end();
});

const HOURS = CHANGE_FEED.retentionDays * 24;
const baseVersion = (): number =>
  2_000_000_000 + Math.floor(Math.random() * 100_000_000);

/** Chèn một dòng outbox có tuổi cho trước, tính bằng giờ */
const insertAged = (version: number, ageHours: number) =>
  client.query(
    `INSERT INTO config_change_log (environment_id, change_type, payload, config_version, created_at)
     VALUES ($1, 'flag.updated', '{}'::jsonb, $2, now() - make_interval(hours => $3))`,
    [envId, version, ageHours],
  );

/** Hạ quyền xuống role — và khẳng định đã hạ, cùng lý do với `asRole` của i30 */
async function becomeRole(role: string): Promise<void> {
  await client.query(`SET LOCAL ROLE ${role}`);
  const who = await client.query<{ current_user: string }>(
    "SELECT current_user",
  );
  if (who.rows[0]?.current_user !== role) {
    throw new Error(`SET ROLE không có hiệu lực: cần ${role}`);
  }
}

const versionsFrom = async (from: number): Promise<number[]> =>
  (
    await client.query<{ v: number }>(
      `SELECT config_version AS v FROM config_change_log
        WHERE environment_id = $1 AND config_version >= $2 ORDER BY 1`,
      [envId, from],
    )
  ).rows.map((r) => r.v);

describe("udp_prune_config_change_log — hành vi", () => {
  it("chỉ xoá dòng quá hạn: biên ±1 giờ quanh CHANGE_FEED.retentionDays", async () => {
    const base = baseVersion();
    const r = await inRollback(client, async () => {
      await insertAged(base, HOURS + 1);
      await insertAged(base + 1, HOURS - 1);
      await becomeRole("udp_s2");
      const deleted = await client.query<{ n: number }>(
        "SELECT udp_prune_config_change_log(10000) AS n",
      );
      return { deleted: deleted.rows[0]?.n, left: await versionsFrom(base) };
    });

    expect(r.error).toBeUndefined();
    expect(r.value?.deleted).toBeGreaterThanOrEqual(1);
    // Dòng còn hạn KHÔNG được chạm — đó là dấu vết replica đang cần
    expect(r.value?.left).toEqual([base + 1]);
  });

  it("xoá theo lô: max_rows chặn số dòng mỗi lần gọi, cũ nhất đi trước", async () => {
    const base = baseVersion();
    const r = await inRollback(client, async () => {
      // Rất cũ để chắc chắn đứng đầu ORDER BY created_at
      await insertAged(base, 24 * 1000 + 3);
      await insertAged(base + 1, 24 * 1000 + 2);
      await insertAged(base + 2, 24 * 1000 + 1);
      await becomeRole("udp_s2");
      const first = await client.query<{ n: number }>(
        "SELECT udp_prune_config_change_log(2) AS n",
      );
      return { first: first.rows[0]?.n, left: await versionsFrom(base) };
    });

    expect(r.error).toBeUndefined();
    expect(r.value?.first).toBe(2);
    expect(r.value?.left).toEqual([base + 2]);
  });

  it.each([0, 10_001])(
    "max_rows = %i ⇒ 22023, không xoá gì",
    async (maxRows) => {
      const r = await inRollback(client, async () => {
        await becomeRole("udp_s2");
        return client.query("SELECT udp_prune_config_change_log($1)", [
          maxRows,
        ]);
      });
      expect(r.error?.code).toBe("22023");
    },
  );
});

describe("udp_prune_config_change_log — quyền (I22)", () => {
  it("udp_s2 vẫn KHÔNG DELETE trực tiếp được — quyền chỉ đi qua hàm", async () => {
    const r = await inRollback(client, async () => {
      await becomeRole("udp_s2");
      return client.query(
        `DELETE FROM config_change_log WHERE environment_id = $1`,
        [envId],
      );
    });
    expect(r.error?.code).toBe("42501");
  });

  it.each(["udp_s1", "udp_s3"])("%s KHÔNG gọi được hàm", async (role) => {
    const r = await inRollback(client, async () => {
      await becomeRole(role);
      return client.query("SELECT udp_prune_config_change_log(1)");
    });
    expect(r.error?.code).toBe("42501");
  });
});
