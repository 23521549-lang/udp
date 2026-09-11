# UDP — Configurable DevOps Platform

Nền tảng DevOps-as-a-Service cho phép developer tự chọn cloud (BYOC/Managed), tự cấu hình
domain và tool qua self-service portal, với feature flags và progressive delivery tích hợp sẵn.

Khóa luận tốt nghiệp — Huỳnh Ngọc Thuận (23521549), Khoa Mạng máy tính và Truyền thông, UIT.
Tài liệu thiết kế: `UDP_design.md` (v4).

## Cấu trúc

```
udp/
├── packages/
│   ├── config/                Hằng số và biến môi trường — nguồn sự thật duy nhất
│   ├── db/                    Prisma schema, migration, test bất biến tầng DB, script quản trị
│   ├── design-lint/           Đối chiếu UDP_design.md với schema, route, package
│   ├── flag-evaluator/        Consistent hashing và đánh giá flag (dùng chung S2 và SDK)
│   ├── http/                  ProblemDetails, error handler, logger cho mọi service
│   └── shared-types/          ProblemDetails, ERROR_CATALOG, schema của serve
├── services/
│   ├── core-backend/          Modular monolith — orchestrator, adapter layer, port 3001
│   ├── flag-service/          Feature Flag Service (OpenFeature), port 3002
│   └── pd-controller/         Progressive Delivery Controller, port 3003
├── apps/
│   └── portal/                React SPA — /app (developer) và /admin (chủ nền tảng)
└── docker/                    Cấu hình hạ tầng dev
```

## Yêu cầu

- Node.js ≥ 20
- pnpm ≥ 9
- Docker Desktop

## Bắt đầu

```powershell
# 1. Cài dependencies
pnpm install

# 2. Chuẩn bị biến môi trường
Copy-Item .env.example .env    # rồi điền các khóa bí mật

# 3. Khởi động Prometheus
#    PostgreSQL nằm trên Supabase, không chạy local — điền DATABASE_URL và
#    DATABASE_URL_DIRECT ở bước 2.
pnpm dev:infra

# 4. Sinh Prisma Client
#    Bắt buộc: client sinh ra bị .gitignore, máy vừa clone chưa có nó.
pnpm db:generate

# 5. Tạo schema database rồi nạp dữ liệu mẫu
pnpm db:migrate
pnpm db:seed

# 6. Cấp LOGIN cho role của từng service rồi chạy service
pnpm db:service-login
pnpm db:service-login udp_s2
pnpm dev:core
pnpm dev:flags
```

> `dev:pd` và `dev:portal` chưa có mã nguồn — thư mục mới chỉ được đặt chỗ, chạy
> các lệnh đó sẽ báo không tìm thấy package.

| Dịch vụ               | URL                   |
| --------------------- | --------------------- |
| Core Backend          | http://localhost:3001 |
| Flag Service          | http://localhost:3002 |
| Prometheus            | http://localhost:9090 |
| Portal, PD Controller | chưa hiện thực        |
| Prisma Studio         | `pnpm db:studio`      |

## Lệnh thường dùng

| Lệnh                                         | Tác dụng                                                                                     |
| -------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `pnpm dev:infra` / `pnpm dev:infra:down`     | Bật/tắt Prometheus                                                                           |
| `pnpm db:migrate`                            | Tạo và áp dụng migration                                                                     |
| `pnpm db:generate`                           | Sinh lại Prisma Client sau khi sửa schema                                                    |
| `pnpm db:seed`                               | Nạp dữ liệu mẫu (idempotent)                                                                 |
| `pnpm db:studio`                             | Mở giao diện xem dữ liệu                                                                     |
| `pnpm typecheck`                             | Kiểm tra kiểu toàn workspace                                                                 |
| `pnpm test`                                  | Chạy test trên database dev đang dùng — nhanh, cho vòng lặp phát triển                       |
| `pnpm test:scratch`                          | Toàn bộ test trên một database dùng-một-lần dựng từ chuỗi migration — đúng lệnh CI chạy      |
| `pnpm db:verify-chain`                       | Dựng lại chuỗi migration từ database trống rồi chạy test của `db` và `design-lint` (~2 phút) |
| `pnpm db:service-login [udp_s2]`             | Cấp LOGIN cho role của một service, ghi chuỗi kết nối vào `.env` (chạy lại là xoay mật khẩu) |
| `pnpm db:ci-bootstrap -- --env-file=.env.ci` | Chuẩn bị project Supabase riêng cho CI, một lần (xem bên dưới)                               |

## CI

Mỗi push và mỗi PR chạy `typecheck`, `lint`, `format:check`, rồi `pnpm test:scratch`
trên một **project Supabase riêng cho CI**, đặt cùng vùng với runner GitHub (`us-east-1`)
để round trip tới database ngắn (đo 71ms, so với ~220ms nếu CI phải nói chuyện với Singapore). Dựng project ấy một lần:

1. Tạo project Supabase (gói free, vùng `us-east-1`), lấy hai chuỗi owner ở Connect:
   Transaction pooler (6543) làm `DATABASE_URL`, Session pooler (5432) làm
   `DATABASE_URL_DIRECT` **kèm `?sslmode=require`**. Ghi hai dòng đó vào `.env.ci`
   (đã bị `.gitignore` chặn).
2. `pnpm db:ci-bootstrap -- --env-file=.env.ci` — áp migration để tạo role `udp_s*`,
   cấp LOGIN cho `udp_s1` và `udp_s2`, ghi ba chuỗi role vào `.env.ci`.
3. `gh secret set -f .env.ci` — nạp cả năm chuỗi lên GitHub.

Mỗi lượt CI dựng database `udp_scratch_ci_<run_id>_<run_attempt>` rồi xoá; job bị huỷ giữa
chừng cũng được dọn bởi bước cuối. Lượt hằng đêm giữ project free của CI không bị tạm dừng.
Trong lúc CI đang chạy vẫn chạy `pnpm test` cục bộ được, vì hai project có ngân sách kết nối riêng.

## Lưu ý bảo mật

Dự án xử lý credential cloud thật. **Không bao giờ commit** `.env`, `kubeconfig`,
`service-account*.json` hay bất kỳ khóa riêng nào — `.gitignore` đã chặn sẵn, nhưng hãy
kiểm tra lại trước mỗi lần push.
