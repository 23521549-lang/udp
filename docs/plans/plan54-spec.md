# Plan #54 — Portal hai ngôn ngữ (Tiếng Việt, English) và chế độ tối hoàn chỉnh

Người dùng (30/09/2026): "làm thêm ngôn ngữ tiếng anh và chế độ giao diện tối nữa nha".

## 1. Hiện trạng

| Việc              | Có                                                                                               | Thiếu                                                                                                                                                                 |
| ----------------- | ------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Ngôn ngữ          | Toàn bộ chữ tiếng Việt, viết thẳng trong mã (~1 500 chuỗi, 93 tệp); `Intl` cố định `vi-VN`       | Không có tầng i18n, không có tiếng Anh, không có bộ chọn ngôn ngữ; `<html lang="vi">` cố định                                                                         |
| Giao diện tối     | Đủ bộ token tối (DESIGN.md §7), `theme-boot.js` áp trước lần vẽ đầu, nút đổi sáng/tối trong menu | Chỉ HAI trạng thái: chọn tay một lần là mất "theo hệ điều hành"; đổi chế độ của hệ điều hành lúc đang mở trang không theo; chưa phép kiểm nào mở màn nào ở chế độ tối |
| Độ tương phản chữ | Token `*-ink` 4.5:1 cho chữ trạng thái (Plan #53)                                                | Chưa đo tự động trên màn thật, ở cả hai chế độ                                                                                                                        |

## 2. Quyết định

### QĐ-1: Tầng i18n tự viết, kiểu chặt, không thư viện

Mỗi phân hệ một tệp `*.messages.ts`:

```ts
export const homeMessages = defineMessages({
  vi: { title: "Trang chủ", greeting: (name: string) => `Chào ${name}` },
  en: { title: "Home", greeting: (name: string) => `Hi ${name}` },
});
// trong component
const m = useMessages(homeMessages);
```

- `defineMessages<V>({ vi: V, en: NoInfer<V> })`: bản tiếng Anh thiếu một khoá, thừa một khoá, hay sai tham số của
  một hàm là **lỗi biên dịch** — cùng tinh thần `Record<ErrorCode, string>` đã dùng ở `errors.ts`.
- Chữ có tham số là **hàm**, không phải chuỗi có `{name}`: TypeScript kiểm tham số, không có bước nội suy lúc chạy
  để sai.
- Số nhiều tiếng Anh qua `count(n, "project", "projects")` (`Intl.PluralRules("en")`); tiếng Việt không chia.
- Bảng nhãn theo enum giữ `satisfies Record<Enum, string>` ở bản `vi`: thêm một trạng thái mà quên chữ vẫn đỏ ở
  biên dịch, cho cả hai ngôn ngữ.

Vì sao không `react-i18next`: khoá chuỗi (`t("flags.title")`) không kiểm được bằng kiểu nếu không sinh mã, tham
số nội suy không kiểm được, và thêm ~40 KB cho một việc hai tệp làm được. Không tách chữ ra JSON: chữ là mã của
giao diện, sống cạnh component dùng nó.

**Chọn ngôn ngữ:** lựa chọn tay (localStorage `udp_locale`) › ngôn ngữ của trình duyệt (`vi*` ⇒ vi, `en*` ⇒ en)
› `vi`. Đổi là tức thì, không tải lại trang; `<html lang>` theo ngôn ngữ (trình đọc màn hình đọc đúng giọng).
Bộ chọn ở menu tài khoản và ở trang đăng nhập/đăng ký (người chưa đăng nhập cũng chọn được).

**Định dạng:** `lib/format.ts` giữ Intl theo ngôn ngữ đang chọn (`vi-VN` / `en-US`): số, tiền USD, ngày giờ,
"2 giờ trước" / "2 hours ago", nhãn ngày của biểu đồ. Thời lượng (`formatDuration`) lấy đơn vị từ messages.

**Không dịch:** dữ liệu của người dùng (tên project, mô tả flag, tên người), tên công cụ và capability, mã
(`metrics.query`, `DEPLOY_SUCCESS` hiện trong JSON thô), và `detail` do máy chủ trả (I37: máy chủ trả MÃ, câu là
của Portal — mã đã có chữ ở cả hai ngôn ngữ).

### QĐ-2: Luật lint giữ cho không chuỗi nào lọt lưới

Thêm vào `tests/design-lint.test.ts`:

1. Không chuỗi hay chữ JSX nào có **dấu tiếng Việt** ngoài `*.messages.ts` (và danh sách miễn trừ khai tường
   minh cho chuỗi chỉ lập trình viên đọc, ví dụ lý do miễn trừ I38 trong `query-keys.ts`).
2. Không **chữ JSX** có chữ cái ngoài `*.messages.ts` (bắt cả chữ không dấu như "Flag", "Tool"), trừ danh sách
   nhỏ tên thương hiệu (`udp`).
3. `aria-label`, `title`, `placeholder`, `alt` không nhận chuỗi viết thẳng — phải là biểu thức (từ messages).
4. Bản `en` của mọi bundle không chứa dấu tiếng Việt (bắt chỗ chép nguyên văn mà quên dịch).

### QĐ-3: Giao diện tối ba lựa chọn, theo hệ điều hành lúc đang mở

- Lựa chọn: **Sáng / Tối / Theo hệ thống**. "Theo hệ thống" là không lưu gì (xoá `udp_theme`); `theme-boot.js`
  giữ nguyên luật (có lưu thì theo, không thì theo hệ điều hành).
- Khi đang "Theo hệ thống", trang nghe `matchMedia("(prefers-color-scheme: dark)")` và đổi ngay khi hệ điều hành
  đổi — không cần tải lại.
- Bộ chọn là một nhóm radio ở menu tài khoản (cùng chỗ với ngôn ngữ); bảng lệnh (Ctrl K) giữ lệnh đổi nhanh.

### QĐ-4: Cổng `portal-demo` kiểm cả hai ngôn ngữ và hai chế độ, và đo tương phản

Cổng Playwright của Plan #53 chạy thêm hai lượt: **tiếng Anh** (máy tính, sáng) và **tối** (máy tính và điện
thoại). Mỗi màn ở mọi lượt kiểm thêm:

- **Tương phản chữ** WCAG AA bằng axe-core (`color-contrast`) — thứ quyết định một giao diện tối "dùng được";
- lượt tiếng Anh: `<html lang="en">`, và vùng khung (thanh bên, đầu trang, tiêu đề) không còn chữ tiếng Việt.

Lỗi tương phản sửa ở NGUỒN (DESIGN.md + bản mẫu, `prototype.css` chép lại nguyên văn) như luật của Plan #53.

### QĐ-5: Chi phí 0

Không dịch vụ dịch, không thư viện trả phí; `@axe-core/playwright` là mã nguồn mở, chạy trong runner miễn phí
của repo public.

## 3. Ngoài phạm vi

- Dịch dữ liệu mẫu của bản xem thử (mô tả flag, tên người, câu lỗi của job): đó là DỮ LIỆU người dùng nhập.
- Ngôn ngữ thứ ba, chữ phải-sang-trái.
- Dịch câu của máy chủ trong `detail` của problem+json (Portal đã dùng mã, không dùng câu).

## 4. Tiêu chí chấp nhận

- **AC-1** Mọi chữ giao diện của Portal nằm trong `*.messages.ts` với hai bản; bốn luật của QĐ-2 xanh.
- **AC-2** Đổi ngôn ngữ ở menu tài khoản và ở trang đăng nhập đổi toàn trang ngay, nhớ qua lần tải lại; `lang`
  đúng; số, ngày, "… trước" theo ngôn ngữ. Test cho bộ chọn, cho định dạng hai ngôn ngữ, và cho vài màn chính ở
  tiếng Anh.
- **AC-3** Ba lựa chọn giao diện; "Theo hệ thống" theo hệ điều hành lúc đang mở (test với `matchMedia` giả).
- **AC-4** Cổng `portal-demo`: bốn lượt (máy tính, điện thoại, tiếng Anh, tối × hai khung) × mọi màn, không lỗi
  tương phản, không lỗi của Plan #53.
- **AC-5** Không thoái cấp: mọi test cũ của Portal xanh ở tiếng Việt (mặc định của test), hợp đồng bản xem thử,
  typecheck, lint, format, design-lint.
- **AC-6** Tài liệu: DESIGN.md (mục ngôn ngữ và giao diện), `UDP_design.md` §10 + D-P46/D-P47, bàn giao.
