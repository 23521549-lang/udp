import { QueryClient } from "@tanstack/react-query";
import { isApiError } from "./http";

/**
 * Cấu hình React Query toàn cục (§10.10).
 *
 * Không thử lại lỗi 4xx: đó là câu trả lời, không phải trục trặc. Không có `onError` toàn
 * cục cho mutation: mỗi form tự quyết lỗi đi đâu (lỗi trường ở cạnh ô nhập, lỗi chung ở
 * toast) — một toast toàn cục sẽ chồng lên lỗi trường mà form đã hiện.
 */
export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 30_000,
        retry: (failureCount, error) => {
          if (isApiError(error) && error.status >= 400 && error.status < 500) {
            return false;
          }
          return failureCount < 2;
        },
        refetchOnWindowFocus: true,
      },
      mutations: { retry: false },
    },
  });
}
