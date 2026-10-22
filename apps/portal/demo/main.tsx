import { QueryClientProvider } from "@tanstack/react-query";
import { createHashHistory, RouterProvider } from "@tanstack/react-router";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { createAppRouter } from "../src/app/router";
import { appMessages } from "../src/app/app.messages";
import { applyTheme, watchSystemTheme } from "../src/app/theme";
import { bootstrapAuth } from "../src/features/auth/session";
import { applyLocale, currentLocale, messagesOf } from "../src/i18n";
import { createQueryClient } from "../src/lib/query-client";
import "../src/styles/prototype.css";
import "../src/styles/portal.css";
import { mountDemoBanner } from "./banner";
import { adoptSetupFromUrl, rememberSignedIn } from "./mock/persona";
import { installMockBackend } from "./mock/server";

/**
 * Bản xem thử của Portal: ĐÚNG mã của `src/`, cùng khởi động như `src/main.tsx`, chỉ khác hai chỗ — backend là
 * lớp giả lập trong trang (`mock/`), và router dùng hash history vì trang tĩnh không phục vụ được đường sâu.
 * Thêm dải "Bản xem thử" để đổi vai người xem (`banner.ts`).
 */
adoptSetupFromUrl();
installMockBackend();
applyTheme();
watchSystemTheme();
applyLocale(currentLocale());
/**
 * [Plan #60 QĐ-8] Đăng nhập GitHub là một ĐIỀU HƯỚNG tới máy chủ, thứ trang tĩnh không có. Bản xem thử giả lập đúng
 * kết cục của máy chủ: từ trang đăng ký (đã tích ô đồng ý) ⇒ tạo tài khoản và vào trang chủ; từ trang đăng nhập ⇒ chưa
 * có tài khoản gắn GitHub nên về trang đăng ký. Nghe ở `window` (sau React): nút đã bị chặn vì chưa tích ô thì bỏ qua.
 */
window.addEventListener("click", (e) => {
  const link = (e.target as Element | null)?.closest("a");
  const href = link?.getAttribute("href") ?? "";
  if (e.defaultPrevented || !href.includes("/auth/github/start")) return;
  e.preventDefault();
  const q = new URL(href, window.location.origin).searchParams;
  if (q.get("intent") === "register" && q.get("acceptTerms") === "1") {
    rememberSignedIn(true);
    window.location.hash = "#/app/home";
    window.location.reload();
  } else {
    window.location.hash = "#/register?oauth=no_account";
  }
});
const banner = document.getElementById("demo-badge");
if (banner !== null) mountDemoBanner(banner);
const queryClient = createQueryClient();
const router = createAppRouter(queryClient, createHashHistory());
const root = createRoot(document.getElementById("root") as HTMLElement);

root.render(
  <div className="boot" role="status">
    {messagesOf(appMessages).loading}
  </div>,
);

void bootstrapAuth(router, queryClient).then(() => {
  root.render(
    <StrictMode>
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>
    </StrictMode>,
  );
});
