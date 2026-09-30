import "@testing-library/jest-dom/vitest";
import { cleanup, configure } from "@testing-library/react";
import { afterAll, afterEach, beforeAll } from "vitest";
import { server } from "./msw";
import { useAuthStore } from "../src/features/auth/auth-store";
import { useToasts } from "../src/components/Toast";
import { usePaletteStore } from "../src/features/project/CommandPalette";
import { useLocaleStore } from "../src/i18n";
import { useHelpStore } from "../src/features/help/HelpDrawer";
import { useShortcutStore } from "../src/lib/shortcuts";

/**
 * Hạn chờ của `findBy*`/`waitFor`: 5 giây thay cho 1 giây mặc định. Một lượt đầy đủ chạy nhiều
 * worker jsdom song song, và trên máy thiếu RAM một lần render + phản hồi msw vượt 1 giây — ô
 * đỏ vì máy chậm chứ không vì Portal sai (đo 26/09: 6 ô đỏ ở lượt đầy đủ, xanh khi chạy riêng).
 * Vẫn dưới `testTimeout` 15 giây, nên một phần tử THẬT SỰ không xuất hiện vẫn làm ô đỏ.
 */
configure({ asyncUtilTimeout: 5_000 });

/**
 * jsdom không có cuộn trang: `scrollRestoration` của router gọi `window.scrollTo` sau mỗi lần điều hướng
 * và jsdom in một lỗi "Not implemented" cho từng lần — hàng trăm dòng che mất cảnh báo thật trong log.
 */
window.scrollTo = () => undefined;

/**
 * Ngôn ngữ của test là tiếng Việt — ngôn ngữ mặc định của sản phẩm. jsdom báo trình duyệt là `en-US`, nên
 * không đặt thì store tự chọn tiếng Anh và mọi câu mà test tìm đều khác. Test tiếng Anh tự đổi rồi được
 * trả về đây sau mỗi ô.
 */
useLocaleStore.setState({ locale: "vi" });

/**
 * `onUnhandledRequest: "error"`: một request mà không handler nào khai là một request
 * test không biết tới — để nó trôi qua im lặng là để test xanh trên một đường không ai
 * kiểm.
 */
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => {
  cleanup();
  server.resetHandlers();
  useAuthStore.setState({ user: null, isInitializing: false });
  useToasts.setState({ items: [] });
  usePaletteStore.setState({ open: false });
  useHelpStore.setState({ open: false });
  useShortcutStore.setState({ enabled: true });
  useLocaleStore.setState({ locale: "vi" });
  document.documentElement.lang = "vi";
  delete document.documentElement.dataset.theme;
  document.cookie = "udp_csrf=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/";
  localStorage.clear();
});
afterAll(() => server.close());
