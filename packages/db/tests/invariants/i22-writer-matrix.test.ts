import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openClient } from "../helpers/db.js";

/**
 * I22 — Ma trận writer được DATABASE cưỡng chế, không phải code review.
 *
 * Bảng dưới đây CỐ Ý lặp lại nội dung của migration `service_roles`. Đó là ghi
 * sổ kép: migration cấp quyền, test khai quyền đáng lẽ phải có, và chúng được
 * viết độc lập. Nếu hai bên khớp thì rất khó cùng sai một kiểu; nếu test đọc
 * chính migration thì nó chỉ chứng minh migration bằng chính migration.
 *
 * Test fail khi THIẾU quyền **và** khi THỪA quyền. Thừa mới là hướng nguy hiểm:
 * quyền dư không làm gãy tính năng nào nên không ai phát hiện, cho tới ngày một
 * service ghi vào bảng của service khác và §1.2 lặng lẽ trở thành sai.
 */

type Priv = "SELECT" | "INSERT" | "UPDATE" | "DELETE";
/** "*" = mọi cột; mảng = đúng những cột này; "ALL_EXCEPT" = mọi cột trừ danh sách */
type ColSpec = "*" | string[] | { allExcept: string[] };
type Grant = Partial<Record<Priv, ColSpec>>;

const FULL: Grant = { SELECT: "*", INSERT: "*", UPDATE: "*", DELETE: "*" };
const APPEND_ONLY: Grant = { SELECT: "*", INSERT: "*" };
const READ_ONLY: Grant = { SELECT: "*" };

/** Tám cột điều khiển rollout — chỉ Service 3 được ghi (§1.2) */
const S3_ROLLOUT_COLUMNS = [
  "claimed_by",
  "claimed_until",
  "current_traffic_percentage",
  "fail_reason",
  "last_decision",
  "last_step_at",
  "status",
  "version",
];

const MATRIX: Record<string, Record<string, Grant>> = {
  udp_s1: {
    users: FULL,
    project_members: FULL,
    projects: FULL,
    cloud_credentials: FULL,
    domain_configs: FULL,
    capability_bindings: FULL,
    capability_preferences: FULL,
    provisioning_jobs: FULL,
    provisioned_resources: FULL,
    // Phien refresh thuoc vong doi tai khoan. S2/S3 KHONG co quyen nao o day,
    // ke ca SELECT: bang chua hash token phien, va khong nhiem vu nao cua hai
    // service do can doc no — cung lap luan voi cloud_credentials.
    refresh_sessions: FULL,
    // Ghi mot lan, khong viet lai: mot hang o day la ban ghi "lan dau da tra ve
    // dung cai nay". Cho UPDATE nghia la mot request sau doi duoc thu ma request
    // phat lai nhan duoc — pha dung tinh chat bang nay sinh ra de bao dam.
    // DELETE thi can, vi don hang qua han lam ngay tren duong ghi (§2.2).
    idempotency_keys: { SELECT: "*", INSERT: "*", DELETE: "*" },
    // config_version/config_hash thuộc S2 (và S3 trong nhánh kill-switch)
    environments: {
      SELECT: "*",
      INSERT: "*",
      DELETE: "*",
      UPDATE: { allExcept: ["config_version", "config_hash"] },
    },
    rollout_sessions: {
      SELECT: "*",
      INSERT: "*",
      DELETE: "*",
      UPDATE: { allExcept: S3_ROLLOUT_COLUMNS },
    },
    audit_logs: APPEND_ONLY,
    deployment_events: APPEND_ONLY,
    rollout_events: APPEND_ONLY,
    domain_catalog: READ_ONLY,
    // S1 đọc bảng của S2 để hiển thị trên Portal
    feature_flags: READ_ONLY,
    flag_variants: READ_ONLY,
    flag_env_configs: READ_ONLY,
    flag_targeting_rules: READ_ONLY,
    segments: READ_ONLY,
    sdk_keys: READ_ONLY,
    flag_evaluation_stats: READ_ONLY,
    config_change_log: READ_ONLY,
  },
  udp_s2: {
    feature_flags: FULL,
    flag_variants: FULL,
    flag_env_configs: FULL,
    flag_targeting_rules: FULL,
    segments: FULL,
    sdk_keys: FULL,
    flag_evaluation_stats: FULL,
    config_change_log: APPEND_ONLY,
    environments: { SELECT: "*", UPDATE: ["config_hash", "config_version"] },
    // [v4.1] ĐỌC đúng năm cột: T12 (lease) + I23 (fencing) trong một truy vấn (§1.2)
    rollout_sessions: {
      SELECT: ["claimed_until", "id", "status", "targeting_rule_id", "version"],
    },
    projects: READ_ONLY,
    domain_catalog: READ_ONLY,
    audit_logs: APPEND_ONLY,
    deployment_events: APPEND_ONLY,
  },
  udp_s3: {
    rollout_sessions: { SELECT: "*", UPDATE: S3_ROLLOUT_COLUMNS },
    rollout_events: APPEND_ONLY,
    // Ngoại lệ kill-switch — ĐÚNG ba quyền, không hơn (§7.6, I30)
    flag_targeting_rules: { SELECT: "*", UPDATE: ["serve"] },
    environments: { SELECT: "*", UPDATE: ["config_hash", "config_version"] },
    config_change_log: { INSERT: "*" },
    projects: READ_ONLY,
    domain_configs: READ_ONLY,
    capability_bindings: READ_ONLY,
    feature_flags: READ_ONLY,
    flag_variants: READ_ONLY,
    flag_env_configs: READ_ONLY,
    domain_catalog: READ_ONLY,
    // Rule dang rollout co the tham chieu segment (rule_type = SEGMENT); thieu
    // quyen nay thi reconciler chet bang 42501 giua vong lap.
    segments: READ_ONLY,
    audit_logs: APPEND_ONLY,
    deployment_events: APPEND_ONLY,
  },
};

const ROLES = Object.keys(MATRIX);
type Actual = Map<string, string[]>; // "role|table|priv" -> cot da sap xep

let client: Client;
let actual: Actual;
let columnsOf: Map<string, string[]>;

beforeAll(async () => {
  client = await openClient();

  const cols = await client.query<{ table_name: string; column_name: string }>(
    `SELECT table_name, column_name FROM information_schema.columns
      WHERE table_schema = 'public' ORDER BY table_name, column_name`,
  );
  columnsOf = new Map();
  for (const r of cols.rows) {
    const list = columnsOf.get(r.table_name) ?? [];
    list.push(r.column_name);
    columnsOf.set(r.table_name, list);
  }

  // PHẢI đọc HAI view, không phải một. `column_privileges` khai triển grant mức
  // bảng ra từng cột nên nó lo được SELECT/INSERT/UPDATE ở cả hai mức — nhưng nó
  // KHÔNG chứa DELETE, vì trong SQL, DELETE là quyền chỉ tồn tại ở mức bảng,
  // không có phiên bản theo cột. Đọc mỗi view đầu sẽ thấy DELETE ở đâu cũng
  // trống và tưởng là thiếu quyền.
  const byColumn = await client.query<{
    grantee: string;
    table_name: string;
    privilege_type: string;
    cols: string[];
  }>(
    `SELECT grantee, table_name, privilege_type, array_agg(column_name::text ORDER BY column_name) AS cols
       FROM information_schema.column_privileges
      WHERE grantee = ANY($1::text[]) AND table_schema = 'public'
        AND privilege_type IN ('SELECT', 'INSERT', 'UPDATE')
      GROUP BY grantee, table_name, privilege_type`,
    [ROLES],
  );
  actual = new Map(
    byColumn.rows.map((r) => [
      `${r.grantee}|${r.table_name}|${r.privilege_type}`,
      r.cols,
    ]),
  );

  const byTable = await client.query<{
    grantee: string;
    table_name: string;
    privilege_type: string;
  }>(
    `SELECT DISTINCT grantee, table_name, privilege_type
       FROM information_schema.role_table_grants
      WHERE grantee = ANY($1::text[]) AND table_schema = 'public'
        AND privilege_type NOT IN ('SELECT', 'INSERT', 'UPDATE')`,
    [ROLES],
  );
  // Quy về cùng hình dạng "danh sách cột" để phần so sánh chỉ có một nhánh.
  for (const r of byTable.rows) {
    actual.set(
      `${r.grantee}|${r.table_name}|${r.privilege_type}`,
      [...(columnsOf.get(r.table_name) ?? [])].sort(),
    );
  }
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

function expand(table: string, spec: ColSpec): string[] {
  const all = columnsOf.get(table);
  if (!all) throw new Error(`Bảng ${table} không tồn tại — ma trận đã lạc hậu`);
  if (spec === "*") return [...all].sort();
  if (Array.isArray(spec)) return [...spec].sort();
  return all.filter((c) => !spec.allExcept.includes(c)).sort();
}

describe("I22 — ma trận writer §1.2", () => {
  it("ba role tồn tại", async () => {
    const r = await client.query<{ rolname: string }>(
      `SELECT rolname FROM pg_roles WHERE rolname = ANY($1::text[]) ORDER BY rolname`,
      [ROLES],
    );
    expect(r.rows.map((x) => x.rolname)).toEqual(ROLES);
  });

  for (const [role, tables] of Object.entries(MATRIX)) {
    for (const [table, grant] of Object.entries(tables)) {
      for (const [priv, spec] of Object.entries(grant) as [Priv, ColSpec][]) {
        it(`${role} có ${priv} trên ${table} đúng phạm vi cột`, () => {
          expect(actual.get(`${role}|${table}|${priv}`) ?? []).toEqual(
            expand(table, spec),
          );
        });
      }
    }
  }

  it("không role nào có quyền THỪA ngoài ma trận", () => {
    const surplus: string[] = [];
    for (const key of actual.keys()) {
      const [role, table, priv] = key.split("|") as [string, string, Priv];
      if (MATRIX[role]?.[table]?.[priv] === undefined) surplus.push(key);
    }
    expect(surplus).toEqual([]);
  });

  it("không role NÀO KHÁC được cấp quyền trên schema public", async () => {
    // Nếu thiếu chốt này, ma trận vẫn xanh trong khi một role thứ tư — ví dụ
    // `service_role` mà Supabase cấp mặc định, hay `PUBLIC` — có ALL trên đúng
    // những bảng đó. Lúc ấy câu "database cưỡng chế quy tắc writer" thành sai
    // mà không có gì báo. Chỉ owner của bảng được phép nằm ngoài ma trận.
    const owner = await client.query<{ tableowner: string }>(
      `SELECT DISTINCT tableowner FROM pg_tables WHERE schemaname = 'public'`,
    );
    const allowed = new Set([...ROLES, ...owner.rows.map((r) => r.tableowner)]);

    const outsiders = await client.query<{ grantee: string }>(
      `SELECT DISTINCT grantee FROM information_schema.role_table_grants
        WHERE table_schema = 'public' AND grantee <> ALL($1::text[])`,
      [[...allowed]],
    );
    expect(outsiders.rows.map((r) => r.grantee)).toEqual([]);
  });

  it("Service 3 KHÔNG chạm được cloud_credentials, kể cả SELECT", () => {
    // ADR-06: quyền vào cluster đi qua endpoint nội bộ của S1, không qua DB.
    const touched = [...actual.keys()].filter((k) =>
      k.startsWith("udp_s3|cloud_credentials|"),
    );
    expect(touched).toEqual([]);
  });

  it("không ai UPDATE hay DELETE được bảng append-only", () => {
    const violations: string[] = [];
    for (const table of ["audit_logs", "deployment_events"]) {
      for (const role of ROLES) {
        for (const priv of ["UPDATE", "DELETE"]) {
          if (actual.has(`${role}|${table}|${priv}`))
            violations.push(`${role}|${table}|${priv}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });
});

/**
 * [v4.1] Hàm `SECURITY DEFINER` — đường ghi mà quyền trên BẢNG không nhìn thấy.
 *
 * Hàm như vậy chạy bằng quyền của owner, nên ai gọi được nó là làm được đúng những
 * gì owner làm trong thân hàm. Một hàm quên `REVOKE ... FROM PUBLIC` là một cửa sau
 * mà mọi phép kiểm trên `role_table_grants` ở trên vẫn xanh. Đã đo trên Supabase:
 * hàm mới trong `public` mặc định cho cả `anon` EXECUTE qua `PUBLIC`.
 *
 * Cùng khuôn ghi sổ kép với MATRIX: danh sách dưới đây viết độc lập với migration.
 */
const DEFINER_FUNCTIONS: Record<string, readonly string[]> = {
  // Dọn ConfigChangeLog quá 7 ngày (§2.2) — S2 không có DELETE trên bảng
  "udp_prune_config_change_log(integer)": ["udp_s2"],
};

/** Role của nền tảng — nếu tồn tại thì KHÔNG được gọi hàm definer nào */
const PLATFORM_ROLES = ["anon", "authenticated", "service_role"];

describe("I22 — hàm SECURITY DEFINER trong schema public", () => {
  it("mọi hàm definer đều được khai — không có hàm nào ngoài danh sách", async () => {
    const r = await client.query<{ sig: string }>(
      `SELECT p.oid::regprocedure::text AS sig
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public' AND p.prosecdef
        ORDER BY 1`,
    );
    expect(r.rows.map((x) => x.sig)).toEqual(
      Object.keys(DEFINER_FUNCTIONS).sort(),
    );
  });

  for (const [signature, allowed] of Object.entries(DEFINER_FUNCTIONS)) {
    it(`${signature}: EXECUTE đúng ${allowed.join(", ")} — không PUBLIC, không role nền tảng`, async () => {
      const present = await client.query<{ rolname: string }>(
        `SELECT rolname FROM pg_roles WHERE rolname = ANY($1::text[]) ORDER BY 1`,
        [[...ROLES, ...PLATFORM_ROLES]],
      );
      const granted: string[] = [];
      for (const { rolname } of present.rows) {
        const res = await client.query<{ ok: boolean }>(
          `SELECT has_function_privilege($1, $2::regprocedure, 'EXECUTE') AS ok`,
          [rolname, signature],
        );
        if (res.rows[0]?.ok === true) granted.push(rolname);
      }
      expect(granted).toEqual([...allowed].sort());

      // PUBLIC không phải một hàng trong pg_roles — đọc thẳng ACL của hàm.
      // proacl NULL nghĩa là quyền MẶC ĐỊNH, tức PUBLIC có EXECUTE.
      const acl = await client.query<{ public_exec: boolean }>(
        `SELECT EXISTS (
            SELECT 1
              FROM pg_proc p,
                   aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a
             WHERE p.oid = $1::regprocedure
               AND a.grantee = 0
               AND a.privilege_type = 'EXECUTE'
          ) AS public_exec`,
        [signature],
      );
      expect(acl.rows[0]?.public_exec).toBe(false);
    });
  }
});

/**
 * [v4.2] Ba lớp mà quyền trên BẢNG không nhìn thấy — đo ngày 12/09/2026 trên hai
 * project Supabase: project MỚI cấp sẵn toàn quyền trên mọi đối tượng mới trong
 * `public` cho `anon`, `authenticated`, `service_role` (6 dòng `pg_default_acl`)
 * và cho cả ba lẫn PUBLIC USAGE trên schema; project dev không có gì trong số
 * đó; database dùng-một-lần tạo từ `template1` không kế thừa default privilege
 * nhưng vẫn mang PUBLIC USAGE mặc định của PostgreSQL 15+.
 *
 * Migration `public_schema_hardening` thu hồi tất cả. Ba test dưới đây canh kết
 * quả (a, b) và chứng minh phép thu hồi có tác dụng trên đúng hình dạng "project
 * mới" (c) — dựng lại trong một transaction rồi ROLLBACK, ngay trên database
 * dùng-một-lần vốn không có hình dạng ấy.
 *
 * Khẳng định PHỦ ĐỊNH, không liệt kê "ACL chỉ có X": owner của `public` là
 * `postgres` trên dev nhưng là `pg_database_owner` trên database mới, và `nspacl`
 * NULL nghĩa là quyền MẶC ĐỊNH (PUBLIC có USAGE) — `aclexplode(NULL)` trả 0 hàng
 * và một test liệt kê sẽ xanh sai. Vì thế đọc qua `acldefault` như test hàm
 * definer ở trên.
 */
const HARDENING_SQL = readFileSync(
  resolve(
    dirname(fileURLToPath(import.meta.url)),
    "../../prisma/migrations/20260912090000_public_schema_hardening/migration.sql",
  ),
  "utf8",
);

/** Role của nền tảng đang tồn tại trên cluster này */
async function presentPlatformRoles(): Promise<string[]> {
  const r = await client.query<{ rolname: string }>(
    `SELECT rolname FROM pg_roles WHERE rolname = ANY($1::text[]) ORDER BY 1`,
    [PLATFORM_ROLES],
  );
  return r.rows.map((x) => x.rolname);
}

describe("I22 [v4.2] — schema public và default privilege không mở cho role nền tảng", () => {
  it("(a) không role nền tảng nào, và không PUBLIC, có USAGE trên schema public", async () => {
    for (const role of await presentPlatformRoles()) {
      const r = await client.query<{ ok: boolean }>(
        `SELECT has_schema_privilege($1, 'public', 'USAGE') AS ok`,
        [role],
      );
      expect(r.rows[0]?.ok, `${role} có USAGE trên public`).toBe(false);
    }
    const pub = await client.query<{ public_usage: boolean }>(
      `SELECT EXISTS (
          SELECT 1
            FROM pg_namespace n,
                 aclexplode(COALESCE(n.nspacl, acldefault('n', n.nspowner))) a
           WHERE n.nspname = 'public' AND a.grantee = 0
        ) AS public_usage`,
    );
    expect(pub.rows[0]?.public_usage).toBe(false);
  });

  it("(a') ba role của UDP vẫn có USAGE — thu hồi PUBLIC không làm chúng mất lối vào", async () => {
    for (const role of ROLES) {
      const r = await client.query<{ ok: boolean }>(
        `SELECT has_schema_privilege($1, 'public', 'USAGE') AS ok`,
        [role],
      );
      expect(r.rows[0]?.ok, role).toBe(true);
    }
  });

  it("(b) default privilege của role tạo đối tượng trong public không có role nền tảng hay PUBLIC", async () => {
    const r = await client.query<{ who: string }>(
      `SELECT DISTINCT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE a.grantee::regrole::text END AS who
         FROM pg_default_acl d, aclexplode(d.defaclacl) a
        WHERE d.defaclnamespace = 'public'::regnamespace
          AND d.defaclrole IN (
                SELECT c.relowner FROM pg_class c WHERE c.relnamespace = 'public'::regnamespace
                UNION SELECT current_user::regrole::oid)
          AND (a.grantee = 0 OR a.grantee::regrole::text = ANY($1::text[]))
        ORDER BY 1`,
      [PLATFORM_ROLES],
    );
    expect(r.rows.map((x) => x.who)).toEqual([]);
  });

  it("(c) SQL của migration thu hồi được hình dạng 'project Supabase mới' — bảng thường trong public, không TEMP", async (ctx) => {
    const roles = await presentPlatformRoles();
    if (!roles.includes("anon")) {
      // PostgreSQL thuần không có role của nền tảng; ca này chỉ có nghĩa trên Supabase
      ctx.skip();
      return;
    }
    const probe = `i22_probe_${Math.random().toString(16).slice(2, 10)}`;
    await client.query("BEGIN");
    try {
      // Hình dạng "project mới": USAGE schema + default privilege + đối tượng mới
      await client.query(`GRANT USAGE ON SCHEMA public TO anon`);
      await client.query(
        `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon`,
      );
      await client.query(
        `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO anon`,
      );
      await client.query(`CREATE TABLE public.${probe} (id int)`);
      await client.query(`CREATE SEQUENCE public.${probe}_seq`);

      const priv = async (): Promise<[boolean, boolean, boolean]> => {
        const r = await client.query<{ s: boolean; t: boolean; q: boolean }>(
          `SELECT has_schema_privilege('anon', 'public', 'USAGE') AS s,
                  has_table_privilege('anon', $1::regclass, 'SELECT') AS t,
                  has_sequence_privilege('anon', $2::regclass, 'USAGE') AS q`,
          [`public.${probe}`, `public.${probe}_seq`],
        );
        const row = r.rows[0];
        if (row === undefined) throw new Error("không đọc được quyền");
        return [row.s, row.t, row.q];
      };

      expect(await priv(), "mô phỏng chưa cấp được quyền").toEqual([
        true,
        true,
        true,
      ]);

      await client.query(HARDENING_SQL);

      expect(await priv()).toEqual([false, false, false]);
      const left = await client.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM pg_default_acl d, aclexplode(d.defaclacl) a
          WHERE d.defaclnamespace = 'public'::regnamespace AND a.grantee::regrole::text = 'anon'`,
      );
      expect(left.rows[0]?.n).toBe(0);
    } finally {
      await client.query("ROLLBACK");
    }
  });
});
