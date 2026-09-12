import type { PrismaClient } from "./generated/prisma/client.js";

/**
 * Nghe từng truy vấn mà một `PrismaClient` phát ra.
 *
 * Người dùng hôm nay: test đếm số round trip của đường lan truyền (I19 [v4.2],
 * I21) và của đường nạp snapshot. Ngày mai: phép đo E4 ("số truy vấn database
 * mỗi lần thay đổi") và bộ đếm truy vấn cho E9.
 *
 * Vì sao cần một lớp mỏng thay vì gọi `$on("query")` thẳng ở nơi dùng:
 *
 *   - `$on` của Prisma là `EventEmitter.on` trần, KHÔNG có `$off`. Mỗi test
 *     đăng ký thẳng một listener là thêm một listener vĩnh viễn trên client
 *     dùng chung của service (được giữ trên `globalThis`), phép đếm của test
 *     sau cộng dồn listener của test trước, và Node cảnh báo
 *     `MaxListenersExceededWarning` sau listener thứ 11. Ở đây mỗi client chỉ
 *     có ĐÚNG MỘT listener thật, phát tiếp cho một `Set` mà hàm gỡ xoá được.
 *   - Kiểu của `$on` phụ thuộc generic `log` của client. `createPrismaClient`
 *     khai trả về `PrismaClient` (generic mặc định) nên `$on("query")` không
 *     biên dịch được ở nơi dùng; ép kiểu ở đúng một chỗ, cạnh nơi bảo đảm nó
 *     đúng (`createPrismaClient` luôn bật `{ emit: "event", level: "query" }`).
 *
 * `BEGIN` của transaction KHÔNG được phát (driver adapter mở transaction bên
 * trong nó), còn `COMMIT` thì có — người đếm round trip nạp dữ liệu phải lọc
 * theo văn bản truy vấn, không đếm mọi sự kiện.
 */
export interface QueryObservation {
  readonly query: string;
  readonly params: string;
  readonly durationMs: number;
  readonly timestamp: Date;
}

export type QueryListener = (observation: QueryObservation) => void;

const listenersByClient = new WeakMap<PrismaClient, Set<QueryListener>>();

/** Đăng ký nghe; trả về hàm gỡ. Chỉ có tác dụng với client dựng bởi `createPrismaClient` */
export function observeQueries(
  client: PrismaClient,
  listener: QueryListener,
): () => void {
  let listeners = listenersByClient.get(client);
  if (listeners === undefined) {
    const created = new Set<QueryListener>();
    listenersByClient.set(client, created);
    listeners = created;
    (client as PrismaClient<"query">).$on("query", (event) => {
      const observation: QueryObservation = {
        query: event.query,
        params: event.params,
        durationMs: event.duration,
        timestamp: event.timestamp,
      };
      for (const fn of created) fn(observation);
    });
  }
  listeners.add(listener);
  const registered = listeners;
  return () => {
    registered.delete(listener);
  };
}
