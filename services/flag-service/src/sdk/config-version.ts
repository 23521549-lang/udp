/**
 * Header cache của `/sdk/config`.
 *
 * `private` và `Vary: Authorization` cùng đóng một lỗ đã đo được: `/sdk/config`
 * là MỘT url duy nhất cho MỌI environment — environment suy ra từ khóa, không từ
 * đường dẫn — trong khi `helmet` không đặt `Cache-Control` cũng không đặt `Vary`
 * (đã dump header). Một cache dùng chung khóa theo URL sẽ trả body của `dev` cho
 * một khóa `prod`. Đó là I14, và nó vỡ mà không cần ai tấn công.
 *
 * `no-cache` chứ KHÔNG `no-store`: `no-cache` nghĩa là "được phép lưu, nhưng
 * phải revalidate trước khi dùng lại" — đúng bằng ngữ nghĩa của cặp ETag/304 mà
 * endpoint này dựng lên. `no-store` cấm luôn việc lưu, tức là cấm luôn thứ làm
 * 304 có ý nghĩa.
 */
export const CONFIG_CACHE_HEADERS: Readonly<Record<string, string>> = {
  "Cache-Control": "private, no-cache",
  Vary: "Authorization",
};
