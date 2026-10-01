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
import { adoptSetupFromUrl } from "./mock/persona";
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
