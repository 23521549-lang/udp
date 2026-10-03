/**
 * [v4.9] Tập tên múi giờ Postgres hiểu (`pg_timezone_names`) — nguồn DUY NHẤT để
 * kiểm tham số `tz` của stats theo flag (§6.7), ở cả Service 1 lẫn Service 2.
 *
 * Tra ở Postgres chứ không ở `Intl`: series được sinh NGAY TRONG SQL, nên thứ phải
 * hiểu tên là tzdata của Postgres; ICU của Node có thể khác phiên bản. Một tên
 * Node nhận mà Postgres không biết là 500 giữa truy vấn thay vì 400 ở biên.
 */

/** Phần của PrismaClient cần ở đây — test truyền bản giả mà không phải ép kiểu */
export interface TimezoneSource {
  $queryRaw<T>(
    query: TemplateStringsArray,
    ...values: unknown[]
  ): PromiseLike<T>;
}

let names: Promise<ReadonlySet<string>> | undefined;

/**
 * Đọc MỘT lần mỗi tiến trình (tập nhỏ, không đổi khi Postgres đang chạy); mọi lời
 * gọi sau dùng lại promise đã nhớ. Lần đọc lỗi thì quên promise đó, để lời gọi kế
 * thử lại — nhớ một promise bị từ chối là khoá chức năng tới lúc khởi động lại.
 */
export function loadTimezoneNames(
  client: TimezoneSource,
): Promise<ReadonlySet<string>> {
  names ??= Promise.resolve(
    client.$queryRaw<{ name: string }[]>`SELECT name FROM pg_timezone_names`,
  ).then(
    (rows) => new Set(rows.map((r) => r.name)),
    (err: unknown) => {
      names = undefined;
      throw err;
    },
  );
  return names;
}
