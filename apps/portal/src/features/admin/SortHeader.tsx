import { ArrowDown, ArrowUp, ArrowUpDown } from "lucide-react";
import { Icon } from "../../components/Icon";
import type { Sort } from "./sort";

/**
 * [Plan #58 UX-34] Tiêu đề cột sắp được: một nút trong `<th>`, `aria-sort` ở cột đang sắp (WAI-ARIA sortable table) —
 * trình đọc màn hình nói "sắp tăng dần/giảm dần". Mũi tên chỉ chiều; cột chưa sắp có mũi tên hai chiều nhạt.
 */
export function SortHeader<K extends string>({
  label,
  column,
  sort,
  onSort,
  num = false,
}: {
  label: string;
  column: K;
  sort: Sort<K>;
  onSort: (column: K) => void;
  num?: boolean;
}) {
  const active = sort.key === column;
  const glyph = !active
    ? ArrowUpDown
    : sort.dir === "asc"
      ? ArrowUp
      : ArrowDown;
  return (
    <th
      scope="col"
      className={num ? "num" : undefined}
      aria-sort={
        active ? (sort.dir === "asc" ? "ascending" : "descending") : undefined
      }
    >
      <button
        type="button"
        className={active ? "th-sort on" : "th-sort"}
        onClick={() => onSort(column)}
      >
        {label}
        <Icon of={glyph} size={12} />
      </button>
    </th>
  );
}
