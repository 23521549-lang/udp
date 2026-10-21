import "@testing-library/jest-dom/vitest";
import { cleanup, configure } from "@testing-library/react";
import { afterAll, afterEach, beforeAll } from "vitest";
import { server } from "./msw";
import { useAuthStore } from "../src/features/auth/auth-store";
import { useToasts } from "../src/components/Toast";
import { usePaletteStore } from "../src/components/CommandPalette";
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
 * Request mà không handler nào khai là một request test không biết tới — để nó trôi qua im lặng là để test
 * xanh trên một đường không ai kiểm. `onUnhandledRequest: "error"` của MSW chỉ IN lỗi và làm request đó hỏng;
 * ô vẫn xanh nếu màn hình chịu được lỗi mạng (log CI: `project-ux58.test.tsx` hỏi `/invitations` và `/teams`
 * mà không ai khai). Nên ghi lại từng request và làm đỏ ô ở `afterEach`.
 */
const unhandledRequests: string[] = [];
beforeAll(() =>
  server.listen({
    onUnhandledRequest: (request, print) => {
      unhandledRequests.push(
        `${request.method} ${new URL(request.url).pathname}`,
      );
      print.error();
    },
  }),
);

/**
 * Hai phần tử cùng `key` là cảnh báo của React chứ không phải lỗi: test vẫn xanh, và React có thể nhân đôi
 * hay bỏ sót một dòng mà không ai thấy. Lần đầu nó lộ ra là trong log CI (`RecentFailedJobs`, vì mock trả cùng
 * một danh sách cho hai trạng thái job). Đổi cảnh báo thành ô đỏ để loại lỗi này không trôi qua lần nữa.
 */
const duplicateKeys: string[] = [];
const consoleError = console.error.bind(console);
console.error = (...args: unknown[]) => {
  const text = args.map(String).join(" ");
  if (text.includes("Encountered two children with the same key")) {
    duplicateKeys.push(text.slice(0, 200));
  }
  consoleError(...args);
};

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

  // Dọn xong rồi mới làm đỏ: ném sớm hơn thì ô sau nhận trạng thái bẩn của ô này.
  const problems = [
    ...unhandledRequests.splice(0).map((r) => `request không ai khai: ${r}`),
    ...duplicateKeys.splice(0).map((w) => `React báo trùng key: ${w}`),
  ];
  if (problems.length > 0) throw new Error(problems.join("\n"));
});
afterAll(() => server.close());
