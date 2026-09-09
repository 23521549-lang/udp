import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  parseColumnTables,
  parseErd,
  readDesignDoc,
  type DocTable,
  type ErdEntity,
} from "../src/design-doc.js";
import {
  modelToTableMap,
  openClient,
  readDbColumns,
  type DbColumn,
} from "../src/db-schema.js";

/**
 * A2 + A3 — §2.1 ERD và §2.2 phải khớp database.
 *
 * Danh sách "ERD thiếu 9 cột của CloudCredential" không còn là thứ ai đó liệt kê
 * bằng tay mỗi vài tuần: nó là ĐẦU RA của test này. Khác biệt giữa hai cách làm
 * là khác biệt giữa "lần này tôi rà kỹ" và "nó không trôi được nữa".
 */

let doc: string[];
let erd: ErdEntity[];
let docTables: DocTable[];
let modelToTable: Map<string, string>;
let dbColumns: Map<string, DbColumn[]>;
let client: Client;

beforeAll(async () => {
  doc = readDesignDoc();
  erd = parseErd(doc);
  docTables = parseColumnTables(doc);
  modelToTable = modelToTableMap();
  client = await openClient();
  dbColumns = await readDbColumns(client);
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

/** Cột kỹ thuật của Prisma/Postgres mà §2.2 cố ý không liệt kê */
const IMPLICIT_COLUMNS = new Set<string>([]);

function dbColumnsOf(entity: string): string[] {
  const table = modelToTable.get(entity);
  if (table === undefined)
    throw new Error(`Không có model ${entity} trong schema.prisma`);
  const cols = dbColumns.get(table);
  if (cols === undefined)
    throw new Error(`Không có bảng ${table} trong database`);
  return cols.map((c) => c.name).filter((c) => !IMPLICIT_COLUMNS.has(c));
}

describe("A2 — §2.1 ERD khớp database", () => {
  it("tập entity của ERD bằng tập model", () => {
    expect([...erd.map((e) => e.name)].sort()).toEqual(
      [...modelToTable.keys()].sort(),
    );
  });

  it("mỗi entity có đủ cột, không thừa không thiếu", () => {
    const problems: string[] = [];
    for (const entity of erd) {
      if (!modelToTable.has(entity.name)) continue;
      const actual = new Set(dbColumnsOf(entity.name));
      const declared = new Set(entity.attributes.map((a) => a.name));

      const missing = [...actual].filter((c) => !declared.has(c)).sort();
      const extra = [...declared].filter((c) => !actual.has(c)).sort();
      if (missing.length)
        problems.push(`${entity.name} THIẾU: ${missing.join(", ")}`);
      if (extra.length)
        problems.push(`${entity.name} THỪA: ${extra.join(", ")}`);
    }
    expect(problems).toEqual([]);
  });
});

describe("A3 — §2.2 bảng cột khớp database", () => {
  it("mỗi heading §2.2 ứng với một model", () => {
    const unknown = docTables
      .map((t) => t.name)
      .filter((n) => !modelToTable.has(n));
    expect(unknown).toEqual([]);
  });

  it("mọi model đều được §2.2 mô tả", () => {
    const described = new Set(docTables.map((t) => t.name));
    const undocumented = [...modelToTable.keys()]
      .filter((m) => !described.has(m))
      .sort();
    expect(undocumented).toEqual([]);
  });

  it("mỗi bảng có đủ cột, không thừa không thiếu", () => {
    const problems: string[] = [];
    for (const table of docTables) {
      if (!modelToTable.has(table.name)) continue;
      const actual = new Set(dbColumnsOf(table.name));
      const declared = new Set(table.columns.map((c) => c.name));

      const missing = [...actual].filter((c) => !declared.has(c)).sort();
      const extra = [...declared].filter((c) => !actual.has(c)).sort();
      if (missing.length)
        problems.push(`${table.name} THIẾU: ${missing.join(", ")}`);
      if (extra.length)
        problems.push(`${table.name} THỪA: ${extra.join(", ")}`);
    }
    expect(problems).toEqual([]);
  });

  it("cột khai NOT NULL trong tài liệu thì database cũng NOT NULL", () => {
    // Chỉ kiểm chiều này. Chiều ngược lại — DB chặt hơn tài liệu — không phải
    // lỗi tài liệu mà là quyết định chưa được ghi, và ép nó ở đây sẽ sinh nhiễu.
    const problems: string[] = [];
    for (const table of docTables) {
      const dbName = modelToTable.get(table.name);
      if (dbName === undefined) continue;
      const byName = new Map(
        (dbColumns.get(dbName) ?? []).map((c) => [c.name, c]),
      );

      for (const col of table.columns) {
        const actual = byName.get(col.name);
        if (actual === undefined) continue;
        const docSaysNotNull =
          /NOT NULL/i.test(col.constraint) && !/NULLABLE/i.test(col.constraint);
        if (docSaysNotNull && actual.nullable) {
          problems.push(
            `${table.name}.${col.name}: tài liệu nói NOT NULL, database cho NULL`,
          );
        }
      }
    }
    expect(problems).toEqual([]);
  });
});

describe("A2/A3 — hai mục của tài liệu phải nói cùng một điều", () => {
  it("ERD và §2.2 mô tả cùng tập cột cho mỗi bảng", () => {
    const byName = new Map(docTables.map((t) => [t.name, t]));
    const problems: string[] = [];
    let compared = 0;

    for (const entity of erd) {
      const table = byName.get(entity.name);
      // `continue` ở đây từng là lỗ pass rỗng: nếu ERD và §2.2 dùng hai quy ước
      // đặt tên khác nhau thì MỌI entity bị bỏ qua, `problems` rỗng, và test
      // báo "hai mục nói cùng một điều" mà chưa so một cột nào. Đếm số lần so
      // thật rồi khẳng định nó khớp số entity — bỏ qua im lặng là không được.
      if (table === undefined) continue;
      compared += 1;
      const inErd = new Set(entity.attributes.map((a) => a.name));
      const inTable = new Set(table.columns.map((c) => c.name));

      const onlyTable = [...inTable].filter((c) => !inErd.has(c)).sort();
      const onlyErd = [...inErd].filter((c) => !inTable.has(c)).sort();
      if (onlyTable.length)
        problems.push(
          `${entity.name}: §2.2 có nhưng ERD không — ${onlyTable.join(", ")}`,
        );
      if (onlyErd.length)
        problems.push(
          `${entity.name}: ERD có nhưng §2.2 không — ${onlyErd.join(", ")}`,
        );
    }
    expect(problems).toEqual([]);
    expect(compared, "số entity thực sự được đối chiếu").toBe(erd.length);
  });
});
