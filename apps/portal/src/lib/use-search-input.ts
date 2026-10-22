import { useEffect, useState } from "react";

/** Ngừng gõ bấy lâu thì từ khoá mới lên URL và máy chủ mới được hỏi */
export const SEARCH_DEBOUNCE_MS = 300;

/**
 * Ô tìm của một danh sách có từ khoá trên URL (Plan #53 QĐ-9: gửi đường dẫn là gửi đúng thứ đang
 * xem). Ô giữ chữ đang gõ ở state; chỉ khi ngừng gõ `SEARCH_DEBOUNCE_MS` thì `commit` nhận từ khoá đã
 * cắt khoảng trắng — chỗ gọi thay URL (không đẩy một mục Back cho mỗi phím) và quay về trang đầu.
 *
 * `commit` phải ổn định (`useCallback`): đổi danh tính mỗi lần render là đặt lại bộ đếm giờ.
 */
export function useSearchInput(
  urlTerm: string,
  commit: (next: string) => void,
): [string, (value: string) => void] {
  const [q, setQ] = useState(urlTerm);
  useEffect(() => {
    const next = q.trim();
    if (next === urlTerm) return;
    const t = setTimeout(() => commit(next), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [q, urlTerm, commit]);
  return [q, setQ];
}
