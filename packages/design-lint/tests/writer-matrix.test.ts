import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  parseWriterMatrix,
  readDesignDoc,
  type WriterMatrixRow,
} from "../src/design-doc.js";
import { modelToTableMap, openClient } from "../src/db-schema.js";

/**
 * A6 — ma trận writer §1.2 trở thành ĐẶC TẢ CHẠY ĐƯỢC.
 *
 * Bản I22 trong `packages/db` khai lại ma trận bằng TypeScript, tức là bản chép
 * thứ hai của migration. Nó vẫn có giá trị (ghi sổ kép: hai bản viết độc lập,
 * khó cùng sai một kiểu), nhưng nó không nối tài liệu vào hệ thống — sửa một ô
 * trong §1.2 mà quên sửa migration thì không có gì đỏ.
 *
 * Test này đọc THẲNG bảng markdown của §1.2 và đối chiếu với grant thật. Từ đây,
 * tài liệu không còn mô tả hệ thống mà bắt đầu ràng buộc nó.
 *
 * PHẠM VI, nói thẳng để không ai tưởng nhiều hơn: cột "Writer" và các ô chia
 * theo cột là văn xuôi có cấu trúc đủ để bóc — tên bảng và tên cột đều nằm
 * trong dấu nháy ngược. Cột "Reader" thì không: nó là câu văn có mệnh đề phủ
 * định và ngoại lệ ("S3 **không** đọc `CloudCredential`"). Phần đó vẫn do I22
 * bên `packages/db` giữ.
 */

const ROLES = ["udp_s1", "udp_s2", "udp_s3"] as const;
type Role = (typeof ROLES)[number];

/** Ô "Writer" của §1.2 dùng "Service 1" / "S1" lẫn lộn; quy về một dạng */
function writerRoleOf(row: WriterMatrixRow): Role | "split" | "append-only" {
  if (/Append-only/i.test(row.writer)) return "append-only";
  if (/Chia theo cột/i.test(row.writer)) return "split";
  const m = /Service\s*(\d)/.exec(row.writer) ?? /\bS(\d)\b/.exec(row.writer);
  if (m?.[1] === undefined)
    throw new Error(
      `§1.2: không xác định được writer — ${row.writer.slice(0, 80)}`,
    );
  return `udp_s${m[1]}` as Role;
}

let rows: WriterMatrixRow[];
let modelToTable: Map<string, string>;
let client: Client;
/** "role|table|priv" -> danh sách cột */
let grants: Map<string, string[]>;
/** tên bảng -> toàn bộ cột của nó */
let tableColumns: Map<string, string[]>;

beforeAll(async () => {
  rows = parseWriterMatrix(readDesignDoc());
  modelToTable = modelToTableMap();
  client = await openClient();

  const res = await client.query<{
    grantee: string;
    table_name: string;
    privilege_type: string;
    cols: string[];
  }>(
    `SELECT grantee, table_name, privilege_type, array_agg(column_name::text ORDER BY column_name) AS cols
       FROM information_schema.column_privileges
      WHERE grantee = ANY($1::text[]) AND table_schema = 'public'
        AND privilege_type IN ('SELECT','INSERT','UPDATE')
      GROUP BY grantee, table_name, privilege_type`,
    [ROLES],
  );
  grants = new Map(
    res.rows.map((r) => [
      `${r.grantee}|${r.table_name}|${r.privilege_type}`,
      r.cols,
    ]),
  );

  const del = await client.query<{
    grantee: string;
    table_name: string;
    privilege_type: string;
  }>(
    `SELECT DISTINCT grantee, table_name, privilege_type
       FROM information_schema.role_table_grants
      WHERE grantee = ANY($1::text[]) AND table_schema = 'public'
        AND privilege_type NOT IN ('SELECT','INSERT','UPDATE')`,
    [ROLES],
  );
  for (const r of del.rows)
    grants.set(`${r.grantee}|${r.table_name}|${r.privilege_type}`, ["*"]);

  const cols = await client.query<{ table_name: string; column_name: string }>(
    `SELECT table_name, column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name <> '_prisma_migrations'`,
  );
  tableColumns = new Map();
  for (const r of cols.rows) {
    tableColumns.set(r.table_name, [
      ...(tableColumns.get(r.table_name) ?? []),
      r.column_name,
    ]);
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

/** Chỉ giữ những tên trong nháy ngược thật sự là model */
function modelsOf(row: WriterMatrixRow): string[] {
  return row.tables.filter((t) => modelToTable.has(t));
}

describe("A6 — §1.2 ràng buộc GRANT thật", () => {
  it("mỗi hàng của ma trận đọc được và nêu ít nhất một bảng", () => {
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) expect(modelsOf(row).length).toBeGreaterThan(0);
  });

  it("service được nêu là writer thì ghi được vào mọi bảng của hàng đó", () => {
    const problems: string[] = [];
    for (const row of rows) {
      const who = writerRoleOf(row);
      const roles: Role[] =
        who === "append-only" ? [...ROLES] : who === "split" ? [] : [who];
      for (const role of roles) {
        for (const model of modelsOf(row)) {
          const table = modelToTable.get(model) as string;
          if (!grants.has(`${role}|${table}|INSERT`)) {
            problems.push(
              `${role} thiếu INSERT trên ${table} (§1.2 khai nó là writer)`,
            );
          }
        }
      }
    }
    expect(problems).toEqual([]);
  });

  it("service KHÔNG được nêu thì không sửa hay xóa được bảng của hàng đó", () => {
    // Đây mới là mệnh đề thật của §1.2: "đúng một service được quyền ghi".
    // Ngoại lệ mức CỘT (kill-switch của S3) được kiểm riêng bên dưới, nên ở đây
    // chỉ tính grant phủ TOÀN BỘ cột — sửa một cột được cấp riêng không phải
    // lấn quyền, mà là ngoại lệ đã ghi trong chính ô đó.
    const problems: string[] = [];
    for (const row of rows) {
      const who = writerRoleOf(row);
      if (who === "append-only" || who === "split") continue;

      for (const model of modelsOf(row)) {
        const table = modelToTable.get(model) as string;
        // Số cột THẬT của bảng, không suy từ grant của chủ sở hữu. Bản trước lấy
        // hợp SELECT+UPDATE của chủ sở hữu làm mẫu số; nếu chủ sở hữu chưa có
        // grant nào — đúng ca §1.2 lệch migration — mẫu số bằng 0 và MỌI grant
        // một cột của role khác bị báo nhầm là "UPDATE toàn bảng".
        const columnCount = (tableColumns.get(table) ?? []).length;
        for (const other of ROLES) {
          if (other === who) continue;
          for (const priv of ["UPDATE", "DELETE"] as const) {
            const cols = grants.get(`${other}|${table}|${priv}`);
            if (cols === undefined) continue;
            const isWholeTable =
              cols[0] === "*" ||
              (columnCount > 0 && cols.length >= columnCount);
            if (isWholeTable)
              problems.push(
                `${other} có ${priv} toàn bảng ${table}, nhưng §1.2 giao cho ${who}`,
              );
          }
        }
      }
    }
    expect(problems).toEqual([]);
  });

  it("phép chia cột của RolloutSession khớp đúng danh sách trong §1.2", () => {
    const row = rows.find((r) => writerRoleOf(r) === "split");
    expect(row, "§1.2 phải có hàng chia theo cột").toBeDefined();

    // Ô đó liệt kê đúng những cột S3 sở hữu, mỗi cột trong một cặp nháy ngược.
    const declared = [
      ...(row as WriterMatrixRow).writer.matchAll(/`([a-z_]+)`/g),
    ]
      .map((m) => m[1] as string)
      .sort();
    const actual = [
      ...(grants.get("udp_s3|rollout_sessions|UPDATE") ?? []),
    ].sort();

    expect(actual).toEqual(declared);
  });

  it("ba quyền kill-switch của S3 khớp đúng những gì §1.2 liệt kê", () => {
    // Ô của hàng Service 2 nêu ngoại lệ bằng `bảng.cột`. Bóc đúng dạng đó rồi
    // đối chiếu: thừa một quyền là §7.6 bị nới ra mà không ai ghi lại.
    const row = rows.find((r) => writerRoleOf(r) === "udp_s2");
    expect(row).toBeDefined();
    // Ngoại lệ được viết ở ô READER, không phải ô Writer — đọc cả hai để chỗ
    // đặt câu văn không quyết định được test có chạy hay không.
    const cell = `${(row as WriterMatrixRow).writer} ${(row as WriterMatrixRow).reader}`;

    const dotted = [...cell.matchAll(/`([a-z_]+)\.([a-z_]+)`/g)].map(
      (m) => [m[1] as string, m[2] as string] as const,
    );
    expect(
      dotted.length,
      "§1.2 phải nêu ngoại lệ dạng `bảng.cột`",
    ).toBeGreaterThan(0);

    // Các cột cùng bảng có thể được nêu tiếp bằng nháy ngược trần ngay sau đó
    const byTable = new Map<string, Set<string>>();
    for (const [table, col] of dotted) {
      const set = byTable.get(table) ?? new Set<string>();
      set.add(col);
      byTable.set(table, set);
    }
    // `?.` ở đây từng nuốt trọn phép kiểm: nếu §1.2 nhắc `config_hash` mà không
    // kèm một `environments.<cột>` nào thì `byTable` chưa có khoá đó, `?.` trả
    // undefined, và grant UPDATE(config_hash) của S3 không bao giờ được đối
    // chiếu — test vẫn xanh với một quyền ghi chéo service không ai kiểm.
    if (/`config_hash`/.test(cell)) {
      const set = byTable.get("environments") ?? new Set<string>();
      set.add("config_hash");
      byTable.set("environments", set);
    }

    const problems: string[] = [];
    for (const [table, cols] of byTable) {
      const actual = new Set(grants.get(`udp_s3|${table}|UPDATE`) ?? []);
      const missing = [...cols].filter((c) => !actual.has(c));
      const extra = [...actual].filter((c) => !cols.has(c));
      if (missing.length)
        problems.push(
          `udp_s3 thiếu UPDATE(${missing.join(",")}) trên ${table}`,
        );
      if (extra.length)
        problems.push(`udp_s3 THỪA UPDATE(${extra.join(",")}) trên ${table}`);
    }
    expect(problems).toEqual([]);

    // Chiều còn lại: mọi bảng mà S3 có UPDATE đều PHẢI được §1.2 nhắc tới.
    // Vòng lặp trên chỉ đi qua bảng tài liệu nêu, nên cấp cho S3 quyền trên một
    // bảng §1.2 không nhắc sẽ lọt hoàn toàn.
    const s3UpdateTables = [...grants.keys()]
      .filter((k) => k.startsWith("udp_s3|") && k.endsWith("|UPDATE"))
      .map((k) => k.split("|")[1] as string);
    const undocumented = s3UpdateTables.filter(
      (t) => !byTable.has(t) && t !== "rollout_sessions",
    );
    expect(undocumented, "S3 ghi được bảng mà §1.2 không nhắc").toEqual([]);
  });
});
