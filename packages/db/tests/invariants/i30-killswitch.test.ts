import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { inRollback, openClient } from "../helpers/db.js";

/**
 * I30 — Kill-switch của Service 3 hoạt động, và CHỈ trong phạm vi được cấp.
 *
 * §7.6 cho S3 đúng ba quyền hẹp trên lãnh địa của S2, để rollback FLAG_LEVEL
 * vẫn chạy khi S2 chết. Bất biến này có hai nửa, và nửa thứ hai mới khó:
 *
 *   (a) Ba quyền đó PHẢI dùng được — thiếu quyền cấp version thì S3 ghi `serve`
 *       mà replica của S2 không bao giờ thấy: kill-switch im lặng, vô tác dụng.
 *   (b) Ngoài ba quyền đó S3 KHÔNG được đụng gì thêm — và phải do DATABASE từ
 *       chối, không phải do code S3 nhớ tự kiềm chế.
 *
 * Dùng SET ROLE thay vì kết nối bằng mật khẩu riêng: role tạo NOLOGIN vì chưa
 * service nào nối bằng chúng, nhưng phép kiểm quyền của Postgres thì giống hệt.
 */

let client: Client;
let ruleId: string;
let envId: string;

beforeAll(async () => {
  client = await openClient();
  const rule = await client.query<{ id: string }>(
    `SELECT id FROM flag_targeting_rules LIMIT 1`,
  );
  const env = await client.query<{ id: string }>(
    `SELECT id FROM environments LIMIT 1`,
  );
  if (rule.rows[0] === undefined || env.rows[0] === undefined) {
    throw new Error("Database chưa seed — chạy `pnpm db:seed` trước");
  }
  ruleId = rule.rows[0].id;
  envId = env.rows[0].id;
});

afterAll(async () => {
  /**
   * Tat luat o DUNG mot dong, va day la ly do.
   *
   * TypeScript coi bien nay la da gan chac chan vi `beforeAll` co gan no.
   * Nhung neu chinh `beforeAll` nem — khong noi duoc database, sai mat khau,
   * seed thieu — thi `afterAll` VAN chay voi bien chua gan. Bo `?.` di thi
   * loi that su bi che boi mot `TypeError` trong buoc don dep, va nguoi doc
   * log thay sai cho hoan toan.
   *
   * Doi kieu thanh `| undefined` la cach dung ve mat kieu nhung bat 64 cho
   * dung khac trong bo test nay phai thu hep — cai gia lon hon nhieu so voi
   * mot dong tat luat co giai thich.
   */
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
  await client?.end();
});

/**
 * Chạy body dưới danh nghĩa role, trong transaction luôn rollback.
 *
 * Khẳng định SET ROLE ĐÃ có hiệu lực trước khi chạy body. Không có bước này thì
 * mọi test phủ định pass giả: "permission denied to set role" cũng là SQLSTATE
 * 42501, nên nếu user chạy test không phải thành viên của role — database khôi
 * phục bằng `pg_dump` không mang membership, hoặc test nối bằng user khác — thì
 * toàn bộ nhóm (b) và (c) xanh mà chưa kiểm gì cả. Lỗi ném ở đây là Error trần,
 * không có `.code`, nên nó KHÔNG khớp `toBe("42501")` và test đỏ đúng như phải.
 */
async function asRole(role: string, body: () => Promise<unknown>) {
  return inRollback(client, async () => {
    await client.query(`SET LOCAL ROLE ${role}`);
    const who = await client.query<{ current_user: string }>(
      "SELECT current_user",
    );
    const actual = who.rows[0]?.current_user;
    if (actual !== role) {
      throw new Error(
        `SET ROLE không có hiệu lực: current_user = ${actual}, cần ${role}`,
      );
    }
    return body();
  });
}

describe("I30(a) — ba quyền kill-switch dùng được", () => {
  it("S3 ghi được flag_targeting_rules.serve", async () => {
    const r = await asRole("udp_s3", () =>
      client.query(
        `UPDATE flag_targeting_rules
            SET serve = (SELECT serve FROM flag_targeting_rules WHERE id = $1)
          WHERE id = $1`,
        [ruleId],
      ),
    );
    expect(r.error).toBeUndefined();
  });

  it("S3 cấp được config_version và config_hash", async () => {
    const r = await asRole("udp_s3", () =>
      client.query(
        `UPDATE environments SET config_version = config_version + 1, config_hash = '' WHERE id = $1`,
        [envId],
      ),
    );
    expect(r.error).toBeUndefined();
  });

  it("S3 ghi được config_change_log", async () => {
    const r = await asRole("udp_s3", () =>
      client.query(
        `INSERT INTO config_change_log (environment_id, change_type, payload, config_version, created_at)
         VALUES ($1, 'kill_switch', '{}'::jsonb, 999999, now())`,
        [envId],
      ),
    );
    expect(r.error).toBeUndefined();
  });
});

describe("I30(b) — ngoài ba quyền đó, database từ chối", () => {
  // 42501 = insufficient_privilege
  it("S3 KHÔNG sửa được cột khác của rule (priority)", async () => {
    const r = await asRole("udp_s3", () =>
      client.query(
        `UPDATE flag_targeting_rules SET priority = 99 WHERE id = $1`,
        [ruleId],
      ),
    );
    expect(r.error?.code).toBe("42501");
  });

  it("S3 KHÔNG xóa được rule", async () => {
    const r = await asRole("udp_s3", () =>
      client.query(`DELETE FROM flag_targeting_rules WHERE id = $1`, [ruleId]),
    );
    expect(r.error?.code).toBe("42501");
  });

  it("S3 KHÔNG sửa được cột khác của environment (name)", async () => {
    const r = await asRole("udp_s3", () =>
      client.query(`UPDATE environments SET name = 'hacked' WHERE id = $1`, [
        envId,
      ]),
    );
    expect(r.error?.code).toBe("42501");
  });

  it("S3 KHÔNG đọc được cloud_credentials (ADR-06)", async () => {
    const r = await asRole("udp_s3", () =>
      client.query(`SELECT id FROM cloud_credentials LIMIT 1`),
    );
    expect(r.error?.code).toBe("42501");
  });

  it("S3 KHÔNG tạo được feature flag", async () => {
    const r = await asRole("udp_s3", () =>
      client.query(
        `INSERT INTO feature_flags (id, project_id, key, flag_type, created_at, updated_at)
         SELECT gen_random_uuid(), id, 'x', 'BOOLEAN', now(), now() FROM projects LIMIT 1`,
      ),
    );
    expect(r.error?.code).toBe("42501");
  });
});

describe("I30(d) — luật GIÁ TRỊ, thứ GRANT không diễn đạt được", () => {
  // §1.2: S1 chỉ ghi RolloutEvent với is_intent = true, S3 chỉ ghi false. Đó là
  // trụ chống race của ADR-01 — chỉ MỘT writer tới đối tượng điều khiển traffic.
  // GRANT nói được "ai chạm cột nào", không nói được "ai ghi GIÁ TRỊ nào", nên
  // luật này phải là trigger. Trước khi có nó, cả hai role có INSERT phẳng và
  // I22 vẫn xanh: một bất biến khẳng định hiện trạng thay vì khẳng định ý đồ.

  /**
   * Dựng một RolloutSession thật rồi mới hạ quyền.
   *
   * Bản đầu của test này dùng `INSERT … SELECT … FROM rollout_sessions LIMIT 1`,
   * mà seed không tạo session nào — SELECT trả 0 hàng nên INSERT chèn 0 hàng,
   * trigger không bao giờ chạy, và cả bốn test xanh mà chưa kiểm gì. Một lệnh
   * ghi "thành công" vì không ghi gì là dạng dương tính giả khó thấy nhất.
   */
  async function withSession(role: string, isIntent: boolean) {
    return inRollback(client, async () => {
      const session = await client.query<{ id: string }>(
        `INSERT INTO rollout_sessions
           (id, project_id, environment_id, rollout_scope, strategy, control_mode,
            thresholds, step_percent, created_by, created_at, updated_at)
         SELECT gen_random_uuid(), p.id, e.id, 'SERVICE_LEVEL', 'CANARY', 'TOOL_DRIVEN',
                '{}'::jsonb, 10, u.id, now(), now()
           FROM projects p, environments e, users u
          WHERE e.project_id = p.id
          LIMIT 1
         RETURNING id`,
      );
      const sessionId = session.rows[0]?.id;
      if (sessionId === undefined)
        throw new Error(
          "Không dựng được rollout_session — database chưa seed?",
        );

      await client.query(`SET LOCAL ROLE ${role}`);
      const who = await client.query<{ current_user: string }>(
        "SELECT current_user",
      );
      if (who.rows[0]?.current_user !== role)
        throw new Error(`SET ROLE không có hiệu lực`);

      await client.query(
        `INSERT INTO rollout_events
           (id, session_id, action, is_intent, traffic_percentage, triggered_by, created_at)
         VALUES (gen_random_uuid(), $1, 'PROMOTE', $2, 10, 'MANUAL', now())`,
        [sessionId, isIntent],
      );
    });
  }

  it("S1 ghi được intent event", async () => {
    const r = await withSession("udp_s1", true);
    expect(r.error).toBeUndefined();
  });

  it("S1 KHÔNG ghi được event thực thi", async () => {
    const r = await withSession("udp_s1", false);
    expect(r.error?.code).toBe("UDP03");
  });

  it("S3 ghi được event thực thi", async () => {
    const r = await withSession("udp_s3", false);
    expect(r.error).toBeUndefined();
  });

  it("S3 KHÔNG ghi được intent event", async () => {
    const r = await withSession("udp_s3", true);
    expect(r.error?.code).toBe("UDP03");
  });

  it("xóa RolloutSession vẫn chạy trót dù event thực thi trỏ về intent", async () => {
    // `caused_by_event_id` là RESTRICT: không xoá được một ý định đã được thi
    // hành. Câu hỏi là RESTRICT đó có chặn nhầm việc xoá cả session không —
    // giống hệt ca FeatureFlag ở I39(e). Khẳng định bằng ĐO, không bằng suy luận.
    const r = await inRollback(client, async () => {
      const session = await client.query<{ id: string }>(
        `INSERT INTO rollout_sessions
           (id, project_id, environment_id, rollout_scope, strategy, control_mode,
            thresholds, step_percent, created_by, created_at, updated_at)
         SELECT gen_random_uuid(), p.id, e.id, 'SERVICE_LEVEL', 'CANARY', 'TOOL_DRIVEN',
                '{}'::jsonb, 10, u.id, now(), now()
           FROM projects p, environments e, users u
          WHERE e.project_id = p.id LIMIT 1
         RETURNING id`,
      );
      const sessionId = session.rows[0]?.id as string;

      const intent = await client.query<{ id: string }>(
        `INSERT INTO rollout_events (id, session_id, action, is_intent, traffic_percentage, triggered_by, created_at)
         VALUES (gen_random_uuid(), $1, 'PROMOTE', true, 10, 'MANUAL', now()) RETURNING id`,
        [sessionId],
      );
      await client.query(
        `INSERT INTO rollout_events
           (id, session_id, action, is_intent, traffic_percentage, triggered_by, caused_by_event_id, created_at)
         VALUES (gen_random_uuid(), $1, 'PROMOTE', false, 20, 'MANUAL', $2, now())`,
        [sessionId, intent.rows[0]?.id],
      );

      await client.query(`DELETE FROM rollout_sessions WHERE id = $1`, [
        sessionId,
      ]);
    });
    expect(r.error).toBeUndefined();
  });

  it("KHÔNG xóa được intent đã có event thực thi trỏ về", async () => {
    const r = await inRollback(client, async () => {
      const session = await client.query<{ id: string }>(
        `INSERT INTO rollout_sessions
           (id, project_id, environment_id, rollout_scope, strategy, control_mode,
            thresholds, step_percent, created_by, created_at, updated_at)
         SELECT gen_random_uuid(), p.id, e.id, 'SERVICE_LEVEL', 'CANARY', 'TOOL_DRIVEN',
                '{}'::jsonb, 10, u.id, now(), now()
           FROM projects p, environments e, users u
          WHERE e.project_id = p.id LIMIT 1
         RETURNING id`,
      );
      const sessionId = session.rows[0]?.id as string;
      const intent = await client.query<{ id: string }>(
        `INSERT INTO rollout_events (id, session_id, action, is_intent, traffic_percentage, triggered_by, created_at)
         VALUES (gen_random_uuid(), $1, 'PROMOTE', true, 10, 'MANUAL', now()) RETURNING id`,
        [sessionId],
      );
      await client.query(
        `INSERT INTO rollout_events
           (id, session_id, action, is_intent, traffic_percentage, triggered_by, caused_by_event_id, created_at)
         VALUES (gen_random_uuid(), $1, 'PROMOTE', false, 20, 'MANUAL', $2, now())`,
        [sessionId, intent.rows[0]?.id],
      );
      // Xoá RIÊNG intent — bản ghi "traffic đã đổi" sẽ mất chủ nếu cho phép
      await client.query(`DELETE FROM rollout_events WHERE id = $1`, [
        intent.rows[0]?.id,
      ]);
    });
    expect(r.error?.code).toBe("23503");
  });
});

describe("I22(b) — grant theo cột phải phủ HẾT bảng", () => {
  // Grant mức cột là ẢNH CHỤP lúc migration chạy, không phải một luật. Thêm cột
  // mới về sau thì nó không thuộc về ai cả — không role nào UPDATE được, và với
  // `rollout_sessions` thì im lặng còn tệ hơn: một cột điều khiển mới lẽ ra phải
  // của S3 lại rơi vào vùng không ai giữ. Chốt này bắt cột mới lộ ra ngay.
  for (const table of ["rollout_sessions", "environments"]) {
    it(`${table}: hợp của các grant UPDATE bằng toàn bộ cột`, async () => {
      const all = await client.query<{ column_name: string }>(
        `SELECT column_name FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = $1`,
        [table],
      );
      const granted = await client.query<{ column_name: string }>(
        `SELECT DISTINCT column_name FROM information_schema.column_privileges
          WHERE table_schema = 'public' AND table_name = $1
            AND privilege_type = 'UPDATE' AND grantee LIKE 'udp_s%'`,
        [table],
      );
      const have = new Set(granted.rows.map((r) => r.column_name));
      const orphans = all.rows
        .map((r) => r.column_name)
        .filter((c) => !have.has(c))
        .sort();
      expect(orphans, "cột không thuộc về service nào").toEqual([]);
    });
  }
});

describe("I30(c) — hướng ngược lại: S2 không lấn sang lãnh địa S3", () => {
  it("S2 KHÔNG sửa được trạng thái rollout", async () => {
    const r = await asRole("udp_s2", () =>
      client.query(`UPDATE rollout_sessions SET status = 'FAILED'`),
    );
    expect(r.error?.code).toBe("42501");
  });

  it("S1 KHÔNG sửa được config_version (đó là con trỏ đọc của ADR-05)", async () => {
    const r = await asRole("udp_s1", () =>
      client.query(`UPDATE environments SET config_version = 1 WHERE id = $1`, [
        envId,
      ]),
    );
    expect(r.error?.code).toBe("42501");
  });

  it("S1 KHÔNG sửa được cột điều khiển traffic của rollout", async () => {
    const r = await asRole("udp_s1", () =>
      client.query(
        `UPDATE rollout_sessions SET current_traffic_percentage = 100`,
      ),
    );
    expect(r.error?.code).toBe("42501");
  });

  // Nửa còn lại của phép chia cột: S3 chỉ được chạm cột điều khiển, không được
  // chạm cột cấu hình mà S1 sở hữu.
  it("S3 KHÔNG sửa được cột cấu hình của rollout", async () => {
    const r = await asRole("udp_s3", () =>
      client.query(`UPDATE rollout_sessions SET step_percent = 50`),
    );
    expect(r.error?.code).toBe("42501");
  });

  it("S3 KHÔNG chèn hay xóa được environment", async () => {
    const r = await asRole("udp_s3", () =>
      client.query(`DELETE FROM environments WHERE id = $1`, [envId]),
    );
    expect(r.error?.code).toBe("42501");
  });

  it("S3 KHÔNG sửa được config_change_log đã ghi (append-only)", async () => {
    const r = await asRole("udp_s3", () =>
      client.query(`UPDATE config_change_log SET change_type = 'x'`),
    );
    expect(r.error?.code).toBe("42501");
  });

  it("S2 KHÔNG đọc được cloud_credentials", async () => {
    const r = await asRole("udp_s2", () =>
      client.query(`SELECT id FROM cloud_credentials LIMIT 1`),
    );
    expect(r.error?.code).toBe("42501");
  });

  it("S2 KHÔNG sửa được cột khác của environment", async () => {
    const r = await asRole("udp_s2", () =>
      client.query(`UPDATE environments SET name = 'x' WHERE id = $1`, [envId]),
    );
    expect(r.error?.code).toBe("42501");
  });
});
