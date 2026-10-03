import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { inRollback, openClient } from "../helpers/db.js";

/**
 * INV-23.1 — mọi flag ACTIVE có `activated_at`, và mốc bằng thời điểm lần chuyển
 * sang ACTIVE gần nhất, với MỌI writer (§2.2, migration `flag_activated_at`).
 *
 * Mốc do trigger `trg_flag_activated_at` đặt, không do code: test chạy SQL thẳng
 * vì thứ đang được kiểm là trigger và CHECK — một writer không đi qua S2 (seed,
 * công cụ vận hành, S2 bản cũ trong cửa sổ rolling deploy) cũng phải có mốc.
 *
 * Trong một transaction `now()` là mốc BẮT ĐẦU transaction, nên "mốc mới" được
 * khẳng định bằng `= now()` sau khi đã đặt mốc cũ là một ngày quá khứ xa.
 */

const OLD_MARK = "2020-01-01T00:00:00.000Z";

let client: Client;
let projectId: string;

beforeAll(async () => {
  client = await openClient();
  const project = await client.query<{ id: string }>(
    `SELECT id FROM projects ORDER BY id LIMIT 1`,
  );
  if (project.rows[0] === undefined) {
    throw new Error("Database chưa seed — chạy `pnpm db:seed` trước");
  }
  projectId = project.rows[0].id;
});

afterAll(async () => {
  // Cung ly do voi i30-killswitch.test.ts: beforeAll nem thi client chua gan.
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
  await client?.end();
});

/** Chèn flag bằng owner; `activatedAt` truyền tường minh để thấy trigger có ghi đè không */
async function insertFlag(
  status: "DRAFT" | "ACTIVE" | "ARCHIVED",
  activatedAt: string | null = null,
): Promise<string> {
  const res = await client.query<{ id: string }>(
    `INSERT INTO feature_flags
       (id, project_id, key, flag_type, lifecycle_status, activated_at, created_at, updated_at)
     VALUES (gen_random_uuid(), $1, 'activated-at-' || gen_random_uuid(), 'BOOLEAN',
             $2, $3, now(), now())
     RETURNING id`,
    [projectId, status, activatedAt],
  );
  const id = res.rows[0]?.id;
  if (id === undefined) throw new Error("INSERT feature_flags không trả id");
  return id;
}

async function update(flagId: string, set: string): Promise<void> {
  await client.query(`UPDATE feature_flags SET ${set} WHERE id = $1`, [flagId]);
}

/** Mốc hiện tại, và nó có đúng bằng `now()` của transaction không (cột lưu 3 chữ số) */
async function markOf(
  flagId: string,
): Promise<{ at: string | null; isNow: boolean }> {
  const res = await client.query<{ at: Date | null; is_now: boolean | null }>(
    `SELECT activated_at AS at, activated_at = now()::timestamptz(3) AS is_now
       FROM feature_flags WHERE id = $1`,
    [flagId],
  );
  const row = res.rows[0];
  if (row === undefined) throw new Error(`không thấy flag ${flagId}`);
  return { at: row.at?.toISOString() ?? null, isNow: row.is_now === true };
}

describe("INV-23.1 — trigger đặt mốc khi CHUYỂN sang ACTIVE", () => {
  it("INSERT thẳng ACTIVE: có mốc, giá trị truyền vào bị ghi đè bằng now()", async () => {
    const r = await inRollback(client, async () => {
      const id = await insertFlag("ACTIVE", OLD_MARK);
      return markOf(id);
    });
    expect(r.error).toBeUndefined();
    expect(r.value?.isNow).toBe(true);
  });

  it("INSERT DRAFT: trigger không đụng, mốc vẫn NULL", async () => {
    const r = await inRollback(client, async () =>
      markOf(await insertFlag("DRAFT")),
    );
    expect(r.error).toBeUndefined();
    expect(r.value).toEqual({ at: null, isNow: false });
  });

  it("DRAFT → ACTIVE: mốc mới", async () => {
    const r = await inRollback(client, async () => {
      const id = await insertFlag("DRAFT");
      await update(id, `lifecycle_status = 'ACTIVE'`);
      return markOf(id);
    });
    expect(r.error).toBeUndefined();
    expect(r.value?.isNow).toBe(true);
  });

  it("ACTIVE → ACTIVE (sửa mô tả) giữ mốc; ACTIVE → ARCHIVED giữ mốc; ARCHIVED → ACTIVE mốc mới", async () => {
    const r = await inRollback(client, async () => {
      const id = await insertFlag("ACTIVE");
      // Hàng đã ACTIVE (OLD = ACTIVE) nên trigger không ghi đè mốc lùi này
      await update(id, `activated_at = '${OLD_MARK}'`);
      const backdated = await markOf(id);

      await update(id, `description = 'sửa mô tả'`);
      const afterEdit = await markOf(id);

      await update(id, `lifecycle_status = 'ARCHIVED'`);
      const afterArchive = await markOf(id);

      await update(id, `lifecycle_status = 'ACTIVE'`);
      const afterRestore = await markOf(id);
      return { backdated, afterEdit, afterArchive, afterRestore };
    });
    expect(r.error).toBeUndefined();
    expect(r.value?.backdated.at).toBe(OLD_MARK);
    expect(r.value?.afterEdit.at).toBe(OLD_MARK);
    expect(r.value?.afterArchive.at).toBe(OLD_MARK);
    expect(r.value?.afterRestore.isNow).toBe(true);
  });

  it("CHECK chặn xoá mốc của hàng ACTIVE (OLD = ACTIVE nên trigger không cứu)", async () => {
    const r = await inRollback(client, async () => {
      const id = await insertFlag("ACTIVE");
      await update(id, `activated_at = NULL`);
    });
    expect(r.error?.code).toBe("23514");
    expect(r.error?.message).toContain("feature_flags_active_has_activated_at");
  });

  it("DRAFT/ARCHIVED được phép không có mốc (CHECK chỉ ràng buộc ACTIVE)", async () => {
    const r = await inRollback(client, async () => {
      await insertFlag("DRAFT");
      await insertFlag("ARCHIVED");
    });
    expect(r.error).toBeUndefined();
  });

  it("AC-5.7: udp_s2 kích hoạt mà KHÔNG nêu cột (mô phỏng S2 cũ) ⇒ thành công, mốc ±5 s", async () => {
    const r = await inRollback(client, async () => {
      const id = await insertFlag("DRAFT");
      await client.query(`SET LOCAL ROLE udp_s2`);
      const who = await client.query<{ current_user: string }>(
        "SELECT current_user",
      );
      if (who.rows[0]?.current_user !== "udp_s2") {
        throw new Error("SET ROLE udp_s2 không có hiệu lực");
      }
      const res = await client.query<{ drift: number }>(
        `UPDATE feature_flags SET lifecycle_status = 'ACTIVE' WHERE id = $1
         RETURNING abs(extract(epoch FROM activated_at - clock_timestamp()))::float8 AS drift`,
        [id],
      );
      return res.rows[0]?.drift;
    });
    expect(r.error).toBeUndefined();
    expect(r.value).toBeDefined();
    expect(r.value).toBeLessThan(5);
  });

  it("hàm trigger là SECURITY INVOKER (DEFINER sẽ làm đổi DEFINER_FUNCTIONS của I22)", async () => {
    const res = await client.query<{ prosecdef: boolean }>(
      `SELECT p.prosecdef FROM pg_proc p
         JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public' AND p.proname = 'udp_set_flag_activated_at'`,
    );
    expect(res.rows).toEqual([{ prosecdef: false }]);
  });

  it("trigger gắn BEFORE INSERT OR UPDATE, FOR EACH ROW trên feature_flags", async () => {
    const res = await client.query<{ timing: string; events: string }>(
      `SELECT action_timing AS timing,
              string_agg(event_manipulation, ',' ORDER BY event_manipulation) AS events
         FROM information_schema.triggers
        WHERE trigger_name = 'trg_flag_activated_at'
          AND event_object_table = 'feature_flags'
          AND action_orientation = 'ROW'
        GROUP BY action_timing`,
    );
    expect(res.rows).toEqual([{ timing: "BEFORE", events: "INSERT,UPDATE" }]);
  });
});

/**
 * Backfill chạy ĐÚNG câu UPDATE trong file migration (đọc từ file, không chép
 * lại) — bản chép sẽ trôi khỏi bản thật mà test vẫn xanh.
 */
function backfillStatement(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const sql = readFileSync(
    resolve(
      here,
      "../../prisma/migrations/20260923090000_flag_activated_at/migration.sql",
    ),
    "utf8",
  );
  const start = sql.indexOf(`UPDATE "feature_flags" f`);
  const endMarker = `WHERE f."lifecycle_status" = 'ACTIVE';`;
  const end = sql.indexOf(endMarker, start);
  if (start < 0 || end < 0) {
    throw new Error("không tìm thấy câu backfill trong migration.sql");
  }
  return sql.slice(start, end + endMarker.length);
}

async function insertAudit(
  flagId: string,
  occurredAt: string,
  action: string,
  before: string | null,
  after: string,
): Promise<void> {
  await client.query(
    `INSERT INTO audit_logs
       (id, project_id, actor_type, action, target_type, target_id, before, after, occurred_at)
     VALUES (gen_random_uuid(), $1, 'SYSTEM', $2, 'FeatureFlag', $3,
             CASE WHEN $4::text IS NULL THEN NULL ELSE jsonb_build_object('lifecycleStatus', $4::text) END,
             jsonb_build_object('lifecycleStatus', $5::text), $6)`,
    [projectId, action, flagId, before, after, occurredAt],
  );
}

describe("INV-23.1 — backfill của migration", () => {
  it("lấy lần kích hoạt GẦN NHẤT theo audit; bỏ qua sửa ACTIVE → ACTIVE và action khác", async () => {
    const r = await inRollback(client, async () => {
      const id = await insertFlag("ACTIVE");
      await insertAudit(
        id,
        "2026-01-01T00:00:00.000Z",
        "flag.update",
        "DRAFT",
        "ACTIVE",
      );
      await insertAudit(
        id,
        "2026-03-01T00:00:00.000Z",
        "flag.update",
        "ARCHIVED",
        "ACTIVE",
      );
      // Muộn hơn nhưng KHÔNG phải kích hoạt: sửa mô tả, và một action khác
      await insertAudit(
        id,
        "2026-04-01T00:00:00.000Z",
        "flag.update",
        "ACTIVE",
        "ACTIVE",
      );
      await insertAudit(
        id,
        "2026-05-01T00:00:00.000Z",
        "flag.create",
        null,
        "ACTIVE",
      );
      await client.query(backfillStatement());
      return markOf(id);
    });
    expect(r.error).toBeUndefined();
    expect(r.value?.at).toBe("2026-03-01T00:00:00.000Z");
  });

  it("không có audit kích hoạt ⇒ `updated_at`; flag DRAFT không bị chạm", async () => {
    const r = await inRollback(client, async () => {
      const active = await insertFlag("ACTIVE");
      const draft = await insertFlag("DRAFT");
      await update(active, `updated_at = '2025-05-05T05:05:05.000Z'`);
      await client.query(backfillStatement());
      return { active: await markOf(active), draft: await markOf(draft) };
    });
    expect(r.error).toBeUndefined();
    expect(r.value?.active.at).toBe("2025-05-05T05:05:05.000Z");
    expect(r.value?.draft.at).toBeNull();
  });
});
