import type { QueryClient } from "@tanstack/react-query";
import type { AnyRouter } from "@tanstack/react-router";
import { isApiError, setSessionExpiredHandler } from "../../lib/http";
import { authApi } from "./auth-api";
import { useAuthStore } from "./auth-store";

/**
 * Nối lớp HTTP với router và store: phiên hết hạn (refresh thất bại) ⇒ xoá người dùng,
 * xoá TOÀN BỘ cache (dữ liệu của phiên cũ không được hiện cho phiên sau), về `/login`
 * kèm đường cũ để quay lại.
 */
export async function bootstrapAuth(
  router: AnyRouter,
  queryClient: QueryClient,
): Promise<void> {
  const store = useAuthStore.getState();

  setSessionExpiredHandler(() => {
    if (useAuthStore.getState().user === null) return;
    useAuthStore.getState().clearUser();
    queryClient.clear();
    const here = router.state.location.href;
    void router.navigate({ to: "/login", search: { redirectTo: here } });
  });

  try {
    const { user } = await authApi.me();
    store.setUser(user);
  } catch (e) {
    // 401 = chưa đăng nhập: bình thường. Lỗi khác: vẫn vào được trang đăng nhập.
    if (!isApiError(e) || e.status !== 401) console.warn("auth/me thất bại", e);
    store.clearUser();
  } finally {
    store.setInitializing(false);
  }
}
