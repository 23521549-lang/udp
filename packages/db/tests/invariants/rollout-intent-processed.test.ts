import { randomUUID } from "node:crypto";
import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openClient } from "../helpers/db.js";

/**
 * Service 3 đánh dấu intent đã xử lý (§2.2 `processed_at`, §7.6) — luật GIÁ TRỊ
 * mà GRANT theo cột không diễn đạt được, nên nằm ở trigger
 * `trg_rollout_event_writer` (migration `rollout_intent_processed`).
 *
 * Bốn điều được cưỡng chế ở tầng database, và test này khẳng định từng điều
 * bằng chính role của service (`SET LOCAL ROLE`), không qua ORM:
 *   1. S3 đặt được `processed_at` trên một hàng intent, đúng một lần.
 *   2. Không đặt lại, không xoá dấu.
 *   3. Không đánh dấu hàng không phải intent (event thực thi của chính S3).
 *   4. Không sửa cột nào khác; S1 không sửa được gì.
 * Luật INSERT cũ (S1 chỉ ghi is_intent = true, S3 chỉ ghi is_intent = false) vẫn
 * còn nguyên — có test ở I30; ở đây chỉ kiểm lại một ca để chắc migration không
 * làm mất nó.
 */

let client: Client;
let projectId: string;
let sessionId: string;
let intentId: string;
let executionId: string;

const ownerId = async (): Promise<string> =>
  (
    await client.query<{ id: string }>(
      `SELECT id FROM users ORDER BY created_at ASC LIMIT 1`,
    )
  ).rows[0]!.id;

beforeAll(async () => {
  client = await openClient();
  const owner = await ownerId();
  const suffix = randomUUID().slice(0, 8);
  projectId = randomUUID();
  const envId = randomUUID();
  sessionId = randomUUID();
  intentId = randomUUID();
  executionId = randomUUID();

  await client.query(
    `INSERT INTO projects (id, owner_id, name, creation_mode, language_runtime, status, resource_quota, expiry_action, domain_set_version, created_at, updated_at)
     VALUES ($1, $2, $3, 'CREATE_NEW', 'nodejs', 'ACTIVE', '{}', 'WARN', 1, now(), now())`,
    [projectId, owner, `intentproc-${suffix}`],
  );
  await client.query(
    `INSERT INTO environments (id, project_id, name, k8s_namespace, is_production, rank, auto_deploy, config_version, config_hash, created_at)
     VALUES ($1, $2, 'dev', $3, false, 0, true, 0, '', now())`,
    [envId, projectId, `udp-intentproc-${suffix}-dev`],
  );
  await client.query(
    `INSERT INTO rollout_sessions
       (id, project_id, environment_id, rollout_scope, strategy, control_mode,
        thresholds, step_percent, created_by, created_at, updated_at)
     VALUES ($1, $2, $3, 'FLAG_LEVEL', 'CANARY', 'UDP_DRIVEN', '{}', 10, $4, now(), now())`,
    [sessionId, projectId, envId, owner],
  );
  // Intent do S1 ghi, event thực thi do S3 ghi — cả hai bằng owner để dựng fixture
  await client.query(
    `INSERT INTO rollout_events (id, session_id, action, is_intent, traffic_percentage, triggered_by, actor_user_id, created_at)
     VALUES ($1, $2, 'PAUSE', true, 0, 'MANUAL', $3, now())`,
    [intentId, sessionId, owner],
  );
  await client.query(
    `INSERT INTO rollout_events (id, session_id, action, is_intent, traffic_percentage, triggered_by, created_at)
     VALUES ($1, $2, 'PROMOTE', false, 10, 'AUTO', now())`,
    [executionId, sessionId],
  );
});

afterAll(async () => {
  await client.query(`DELETE FROM projects WHERE id = $1`, [projectId]);
  await client.end();
});

/** Chạy `sql` dưới role, trong transaction LUÔN rollback; trả mã lỗi hoặc số hàng */
async function asRole(
  role: string,
  sql: string,
  params: unknown[],
): Promise<{ code: string | undefined; rowCount: number }> {
  await client.query("BEGIN");
  try {
    await client.query(`SET LOCAL ROLE ${role}`);
    const r = await client.query(sql, params);
    return { code: undefined, rowCount: r.rowCount ?? 0 };
  } catch (err) {
    return { code: (err as { code?: string }).code, rowCount: 0 };
  } finally {
    await client.query("ROLLBACK");
  }
}

describe("processed_at — S3 đánh dấu intent đã xử lý, đúng một lần", () => {
  it("S3 đặt được processed_at trên hàng intent còn trống", async () => {
    const r = await asRole(
      "udp_s3",
      `UPDATE rollout_events SET processed_at = now() WHERE id = $1`,
      [intentId],
    );
    expect(r).toEqual({ rowCount: 1 });
  });

  it("đặt rồi thì không đặt lại, không xoá được (UDP03)", async () => {
    await client.query("BEGIN");
    try {
      await client.query(
        `UPDATE rollout_events SET processed_at = now() WHERE id = $1`,
        [intentId],
      );
      await client.query(`SET LOCAL ROLE udp_s3`);
      const again = await client
        .query(`UPDATE rollout_events SET processed_at = now() WHERE id = $1`, [
          intentId,
        ])
        .then(
          () => "ok",
          (e: { code?: string }) => e.code,
        );
      expect(again).toBe("UDP03");
    } finally {
      await client.query("ROLLBACK");
    }

    const unset = await asRole(
      "udp_s3",
      `UPDATE rollout_events SET processed_at = NULL WHERE id = $1`,
      [intentId],
    );
    // NULL → NULL: trigger từ chối vì NEW.processed_at IS NULL
    expect(unset.code).toBe("UDP03");
  });

  it("không đánh dấu được hàng KHÔNG phải intent (UDP03)", async () => {
    const r = await asRole(
      "udp_s3",
      `UPDATE rollout_events SET processed_at = now() WHERE id = $1`,
      [executionId],
    );
    expect(r.code).toBe("UDP03");
  });

  it("S3 không sửa được cột nào khác của rollout_events (42501)", async () => {
    for (const column of [
      "reason = 'x'",
      "action = 'RESUME'",
      "is_intent = false",
    ]) {
      const r = await asRole(
        "udp_s3",
        `UPDATE rollout_events SET ${column}, processed_at = now() WHERE id = $1`,
        [intentId],
      );
      expect(r.code, column).toBe("42501");
    }
  });

  it("S1 không sửa được rollout_events (42501 — không có UPDATE)", async () => {
    const r = await asRole(
      "udp_s1",
      `UPDATE rollout_events SET processed_at = now() WHERE id = $1`,
      [intentId],
    );
    expect(r.code).toBe("42501");
  });

  it("luật INSERT cũ còn nguyên: S3 không ghi được is_intent = true (UDP03)", async () => {
    const r = await asRole(
      "udp_s3",
      `INSERT INTO rollout_events (id, session_id, action, is_intent, traffic_percentage, triggered_by, created_at)
       VALUES ($1, $2, 'PAUSE', true, 0, 'MANUAL', now())`,
      [randomUUID(), sessionId],
    );
    expect(r.code).toBe("UDP03");
  });
});
