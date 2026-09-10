/**
 * ETag của `/sdk/config`.
 *
 * §9 khai `configVersion: number; // = ETag`, và §6.3 ràng thêm một đẳng thức
 * nữa: "`ETag` của lần GET đầu chính là `since` của SSE". Hai câu đó cộng lại
 * chốt giá trị: ETag là `config_version`, KHÔNG kèm gì khác. Ghép `keyType` vào
 * — như một chú thích ở §3.2 từng gợi ý — làm `since` không parse ra số được, và
 * khe hở mà §6.3 dựng đẳng thức đó để bịt sẽ mở lại: sự kiện xảy ra giữa lúc GET
 * xong và lúc SSE nối được.
 *
 * `(envId, keyType)` vẫn là khóa của CACHE, chỉ không phải giá trị trên dây. Hai
 * thứ khác nhau: một cái định danh chỗ để, một cái là bộ xác thực HTTP.
 */

/**
 * NGOẶC KÉP là bắt buộc, không phải trang trí.
 *
 * `ETag: 47` không phải một entity-tag hợp lệ. Đã đo trên `http.request` thô:
 * server đặt ETag không ngoặc, client gửi lại `If-None-Match: "47"` — vì mọi
 * client đúng chuẩn đều tự thêm ngoặc — và server trả **200 kèm nguyên body**,
 * mọi lần. Triệu chứng không phải lỗi mà là im lặng: 304 không bao giờ xảy ra,
 * nên chế độ polling fallback 30 giây của SDK (§6.3) tải full snapshot vĩnh
 * viễn, và không có gì trong log nói rằng có gì đó sai.
 *
 * Tag MẠNH (không có tiền tố `W/`): body là byte-for-byte xác định bởi
 * `config_version`, nên không cần ngữ nghĩa "tương đương yếu". Express so
 * `If-None-Match` theo kiểu yếu ở cả hai chiều nên `W/"47"` từ client vẫn khớp.
 */
export const etagOf = (configVersion: number): string =>
  `"${String(configVersion)}"`;

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
