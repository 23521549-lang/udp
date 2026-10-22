import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createBrowserHistory,
  createMemoryHistory,
  RouterProvider,
} from "@tanstack/react-router";
import type { PublicUserWire } from "@udp/shared-types/wire";
import { render } from "@testing-library/react";
import { createAppRouter } from "../src/app/router";
import { useAuthStore } from "../src/features/auth/auth-store";

export const USER: PublicUserWire = {
  id: "0f0f0f0f-0f0f-4f0f-8f0f-0f0f0f0f0f0f",
  email: "dev@udp.local",
  name: "Dev Tester",
  platformRole: "USER",
};

/**
 * Dựng CẢ ỨNG DỤNG ở một URL — router thật, guard thật, React Query thật; chỉ mạng là
 * msw (với body lấy từ golden capture). Test đi qua đúng đường người dùng đi.
 */
export function renderApp(
  url: string,
  {
    user = USER,
    history = "memory",
  }: {
    user?: PublicUserWire | null;
    /**
     * "browser": history thật của jsdom. Cần cho test chặn-rời-trang: memory history của TanStack không
     * giữ blocker nào (`block` là no-op), còn trình duyệt và hash history của bản xem thử thì giữ.
     */
    history?: "memory" | "browser";
  } = {},
) {
  useAuthStore.setState({ user, isInitializing: false });
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  // CHÍNH cấu hình router của ứng dụng (trang 404 mặc định, cuộn…), chỉ đổi history
  if (history === "browser") window.history.replaceState(null, "", url);
  const router = createAppRouter(
    queryClient,
    history === "browser"
      ? createBrowserHistory()
      : createMemoryHistory({ initialEntries: [url] }),
  );
  const view = render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return { ...view, router, queryClient };
}
