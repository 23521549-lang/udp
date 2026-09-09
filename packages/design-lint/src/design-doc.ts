import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Đọc `docs/UDP_design.md` thành cấu trúc so sánh được.
 *
 * Vì sao package này tồn tại: đây là vòng thứ năm tìm chỗ lệch giữa tài liệu và
 * code, và vòng nào cũng tìm ra. Nguyên nhân không phải bất cẩn mà là hình dạng
 * — §2.1 ERD là bản chép của §2.2, §2.2 là bản chép của schema, ba bản của cùng
 * một sự thật giữ khớp nhau bằng trí nhớ. Chính luận điểm của UDP bác bỏ cấu
 * trúc đó: ADR-08 bỏ state file vì lý do y hệt. §2.1 CHÍNH LÀ một state file
 * cho schema, chỉ khác là nó viết bằng tiếng người.
 *
 * NGUYÊN TẮC: gặp thứ không phân tích được thì NÉM, không bỏ qua. Bài học từ
 * `udp_serve_variant_ids` — trả rỗng cho hình dạng không hiểu là im lặng cho
 * qua, và một linter im lặng còn tệ hơn không có linter, vì nó tạo cảm giác
 * đã được canh.
 */

const here = dirname(fileURLToPath(import.meta.url));
const DOC_PATH = resolve(here, "../../../docs/UDP_design.md");

export function readDesignDoc(): string[] {
  return readFileSync(DOC_PATH, "utf8").split(/\r?\n/);
}

export interface ErdAttribute {
  type: string;
  name: string;
  key: "PK" | "FK" | "UK" | null;
  comment: string | null;
}

export interface ErdEntity {
  name: string;
  attributes: ErdAttribute[];
}

/** Phân tích khối mermaid `erDiagram` của §2.1 */
export function parseErd(lines: string[]): ErdEntity[] {
  const start = lines.findIndex((l) => l.trim() === "erDiagram");
  if (start < 0) throw new Error("§2.1: không tìm thấy khối erDiagram");

  const end = lines.findIndex((l, i) => i > start && l.trim() === "```");
  if (end < 0) throw new Error("§2.1: khối erDiagram không đóng");

  const entities: ErdEntity[] = [];
  let current: ErdEntity | null = null;

  for (const raw of lines.slice(start + 1, end)) {
    const line = raw.trim();
    if (line === "" || line.startsWith("%%")) continue;

    const open = /^(\w+)\s*\{$/.exec(line);
    if (open?.[1] !== undefined) {
      current = { name: open[1], attributes: [] };
      entities.push(current);
      continue;
    }
    if (line === "}") {
      current = null;
      continue;
    }

    if (current === null) {
      // Ngoài entity thì chỉ được phép là dòng quan hệ (||--o{ …)
      if (/(\|\||\}o|o\{|\|\{|--)/.test(line)) continue;
      throw new Error(`§2.1: dòng lạ ngoài entity — ${line}`);
    }

    const attr = /^(\w+)\s+(\w+)(?:\s+(PK|FK|UK))?(?:\s+"([^"]*)")?$/.exec(
      line,
    );
    if (attr?.[1] === undefined || attr[2] === undefined) {
      throw new Error(
        `§2.1: không đọc được thuộc tính của ${current.name} — ${line}`,
      );
    }
    current.attributes.push({
      type: attr[1],
      name: attr[2],
      key: (attr[3] as ErdAttribute["key"]) ?? null,
      comment: attr[4] ?? null,
    });
  }
  return entities;
}

export interface DocColumn {
  name: string;
  type: string;
  constraint: string;
}

export interface DocTable {
  /** Tên trong heading `#### \`TenBang\`` — dạng PascalCase của §2.2 */
  name: string;
  columns: DocColumn[];
}

/**
 * Heading `#### \`X\`` trong §2.2 mà KHÔNG mô tả một bảng.
 *
 * Danh sách này phải ngắn và mỗi mục phải giải thích được — nó là ngoại lệ có
 * kiểm soát, không phải chỗ để giấu bảng chưa viết xong.
 */
const NOT_A_TABLE = new Set([
  // Hình dạng JSONB của Environment.tracked_flags, không phải bảng riêng
  "trackedFlags",
]);

/**
 * Phân tích bảng cột của §2.2.
 *
 * Chỉ lấy bảng markdown ĐẦU TIÊN sau mỗi heading. Vài mục còn bảng phụ (ma trận
 * quyền của `ProjectMember`, bảng loại khoá của `SdkKey`) và chúng có cột hoàn
 * toàn khác — gộp vào sẽ ra rác.
 */
export function parseColumnTables(lines: string[]): DocTable[] {
  const tables: DocTable[] = [];

  for (let i = 0; i < lines.length; i++) {
    const heading = /^####\s+`(\w+)`/.exec(lines[i] ?? "");
    if (heading?.[1] === undefined) continue;
    const name = heading[1];
    if (NOT_A_TABLE.has(name)) continue;

    const columns: DocColumn[] = [];
    let inTable = false;
    let done = false;

    for (
      let j = i + 1;
      j < lines.length && !/^#{2,4}\s/.test(lines[j] ?? "");
      j++
    ) {
      const line = lines[j] ?? "";
      if (!line.startsWith("|")) {
        // Bảng đầu tiên kết thúc ở dòng không phải bảng
        if (inTable) done = true;
        continue;
      }
      if (done) break;

      const cells = line
        .split("|")
        .slice(1, -1)
        .map((c) => c.trim());
      if (cells.length < 3) continue;

      const first = cells[0] ?? "";
      if (/^[-: ]+$/.test(first)) continue;
      if (/^(Cột|Column)$/i.test(first)) {
        inTable = true;
        continue;
      }
      if (!inTable) continue;

      if (!/^[a-z_][a-z0-9_]*$/.test(first)) {
        throw new Error(
          `§2.2 ${name}: ô đầu không phải tên cột — ${first.slice(0, 60)}`,
        );
      }
      columns.push({
        name: first,
        type: cells[1] ?? "",
        constraint: cells[2] ?? "",
      });
    }

    if (columns.length === 0) {
      throw new Error(
        `§2.2 ${name}: không đọc được cột nào — thêm vào NOT_A_TABLE nếu đúng là không phải bảng`,
      );
    }
    tables.push({ name, columns });
  }
  return tables;
}

export interface WriterMatrixRow {
  tables: string[];
  writer: string;
  reader: string;
}

/** Phân tích ma trận writer §1.2 — nguồn sự thật của bất biến I22 */
export function parseWriterMatrix(lines: string[]): WriterMatrixRow[] {
  const header = lines.findIndex((l) =>
    /^\|\s*Bảng\s*\|\s*Writer\s*\|/.test(l),
  );
  if (header < 0) throw new Error("§1.2: không tìm thấy bảng ma trận writer");

  const rows: WriterMatrixRow[] = [];
  for (
    let i = header + 2;
    i < lines.length && (lines[i] ?? "").startsWith("|");
    i++
  ) {
    const cells = (lines[i] ?? "")
      .split("|")
      .slice(1, -1)
      .map((c) => c.trim());
    const tables = [...(cells[0] ?? "").matchAll(/`(\w+)`/g)].map(
      (m) => m[1] as string,
    );
    if (tables.length === 0) {
      throw new Error(
        `§1.2: hàng không nêu bảng nào — ${(cells[0] ?? "").slice(0, 60)}`,
      );
    }
    rows.push({ tables, writer: cells[1] ?? "", reader: cells[2] ?? "" });
  }
  return rows;
}
