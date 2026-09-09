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
