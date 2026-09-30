import { QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { createAppRouter } from "./app/router";
import { appMessages } from "./app/app.messages";
import { applyTheme, watchSystemTheme } from "./app/theme";
import { applyLocale, currentLocale, messagesOf } from "./i18n";
import { bootstrapAuth } from "./features/auth/session";
import { createQueryClient } from "./lib/query-client";
import "./styles/prototype.css";
import "./styles/portal.css";
import "./styles/ux.css";

/**
 * Khởi động: xác định phiên TRƯỚC khi dựng router (§10.3 "loading gate"). Guard của
 * `/app` đọc Zustand; dựng router trước khi `GET /auth/me` trả lời là để guard quyết
 * định trên một trạng thái chưa biết.
 */
applyTheme();
watchSystemTheme();
applyLocale(currentLocale());
const queryClient = createQueryClient();
const router = createAppRouter(queryClient);
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
