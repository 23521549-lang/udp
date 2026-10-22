/**
 * **I28** (§13.3) [Plan #50] — thêm adapter không chạm tệp nào ngoài thư mục của nó.
 *
 * Phần thuần của cổng CI: đọc danh sách tệp đổi của MỘT commit và nói commit đó có thêm tool không,
 * và tệp nào nằm ngoài thư mục tool mới. Lớp git ở `i28-gate.ts`.
 *
 * Định nghĩa "thư mục tool" ở đây là DUY NHẤT cho cả repo: E1 (`@udp/experiments`) đếm tệp ngoài adapter
 * theo đúng định nghĩa này — phép đo và cổng cưỡng chế cùng một chỉ số không được hiểu nó theo hai cách.
 */

const TOOL_INDEX =
  /^(services\/core-backend\/src\/modules\/[a-z-]+-adapter\/[a-z0-9-]+)\/index\.ts$/;

/** Thư mục tool từ đường dẫn `index.ts` của nó, hoặc `null` */
export function toolDirOf(indexPath: string): string | null {
  return TOOL_INDEX.exec(indexPath)?.[1] ?? null;
}

/** Một dòng của `git diff-tree --name-status`: rename/copy mang HAI đường dẫn, mọi loại khác một */
export interface FileChange {
  /** Chữ cái trạng thái của git: A, M, D, R, C, T */
  status: string;
  paths: readonly string[];
}

/**
 * Đọc đầu ra `git diff-tree -z --name-status` — ngăn bằng NUL, nên tên tệp có khoảng trắng hay ký tự
 * không ASCII không bị git trích dẫn và không bị cắt sai.
 */
export function parseNameStatus(raw: string): FileChange[] {
  const fields = raw.split("\0").filter((f) => f !== "");
  const out: FileChange[] = [];
  for (let i = 0; i < fields.length;) {
    const status = (fields[i] ?? "").charAt(0);
    const arity = status === "R" || status === "C" ? 2 : 1;
    out.push({ status, paths: fields.slice(i + 1, i + 1 + arity) });
    i += 1 + arity;
  }
  return out;
}

export interface AdapterCommitVerdict {
  /** Thư mục tool mà commit THÊM (`index.ts` mới); rỗng ⇒ commit không thuộc phạm vi I28 */
  tools: string[];
  /** Đường dẫn đổi nằm ngoài mọi thư mục tool mới — khác rỗng là vi phạm */
  outside: string[];
}

/**
 * Commit thêm tool ⇔ có `index.ts` MỚI dưới `*-adapter/<tool>/` (rename không tính: đổi tên một tool có sẵn
 * không phải thêm tool). Khi đó MỌI đường dẫn — cả hai phía của rename, cả tài liệu lẫn test — phải nằm
 * trong một thư mục tool mới của chính commit ấy, đúng chữ §13.3.
 */
export function checkAdapterCommit(
  changes: readonly FileChange[],
): AdapterCommitVerdict {
  const tools = [
    ...new Set(
      changes
        .filter((c) => c.status === "A")
        .map((c) => toolDirOf(c.paths[0] ?? ""))
        .filter((dir): dir is string => dir !== null),
    ),
  ].sort();
  if (tools.length === 0) return { tools, outside: [] };
  const inside = (path: string): boolean =>
    tools.some((dir) => path.startsWith(`${dir}/`));
  const outside = [
    ...new Set(changes.flatMap((c) => c.paths).filter((p) => !inside(p))),
  ].sort();
  return { tools, outside };
}
