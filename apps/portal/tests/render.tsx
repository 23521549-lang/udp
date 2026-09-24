import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import type { PublicUserWire } from "@udp/shared-types/wire";
import { render } from "@testing-library/react";
import { routeTree } from "../src/app/router";
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
  { user = USER }: { user?: PublicUserWire | null } = {},
) {
  useAuthStore.setState({ user, isInitializing: false });
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const router = createRouter({
    routeTree,
    context: { queryClient },
    history: createMemoryHistory({ initialEntries: [url] }),
  });
  const view = render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return { ...view, router, queryClient };
}
