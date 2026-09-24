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
│   ├── experiments/           Harness phép đo §14 (E3, E4, E5, E14) và I34 — kết quả ở docs/measurements
│   ├── flag-evaluator/        Consistent hashing và đánh giá flag (dùng chung S2 và SDK)
│   ├── flag-snapshot/         Snapshot cấu hình flag + config_hash + delta outbox (S2 và kill-switch S3)
│   ├── http/                  ProblemDetails, error handler, logger cho mọi service
│   ├── metrics-provider/      MetricsProvider: Prometheus và bản giả cho test (S1 probe pha 1, S3 quyết định)
│   ├── openfeature-provider/  Provider OpenFeature (SERVER key) chạy trong ứng dụng khách + hook nhãn ff + middleware /metrics
│   ├── shared-types/          ProblemDetails, ERROR_CATALOG, schema của serve và của rollout
│   └── test-support/          Chỉ cho test: dựng service thật bằng tiến trình con, fixture flag/SDK key, bộ sinh I26
├── services/
│   ├── core-backend/          Modular monolith — orchestrator, adapter layer, port 3001
│   ├── flag-service/          Feature Flag Service (OpenFeature), port 3002
│   └── pd-controller/         Progressive Delivery Controller, port 3003
├── apps/
│   ├── portal/                React SPA — /app (developer) và /admin (chủ nền tảng)
│   └── sample-app/            Ứng dụng khách mẫu: provider + nhãn ff + /metrics + chaos (E5), port 3010
├── docs/
│   ├── UDP_design.md          Tài liệu thiết kế
│   ├── design/                Design system Portal đã duyệt + bản mẫu bấm được (chuẩn cho Plan #25)
│   └── measurements/          Kết quả đo, đăng ký trước E5, sổ nợ kiểm chứng
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
pnpm db:service-login udp_s3
pnpm dev:core
pnpm dev:flags
pnpm dev:pd
pnpm dev:portal
```

> `pnpm dev:portal` chạy Portal ở http://localhost:5173 và proxy `/api` sang Core Backend
> (cổng 3001) — cùng origin nên cookie httpOnly đi kèm mà không cần CORS. PD Controller
> cần Flag Service đang chạy (`FLAG_SERVICE_URL`) và Prometheus (`PROMETHEUS_URL`) để đo
> canary.

| Dịch vụ       | URL                   |
| ------------- | --------------------- |
| Core Backend  | http://localhost:3001 |
| Flag Service  | http://localhost:3002 |
| PD Controller | http://localhost:3003 |
| Prometheus    | http://localhost:9090 |
| Portal        | http://localhost:5173 |
| Prisma Studio | `pnpm db:studio`      |

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
| `pnpm db:service-login [udp_s2\|udp_s3]`     | Cấp LOGIN cho role của một service, ghi chuỗi kết nối vào `.env` (chạy lại là xoay mật khẩu) |
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
   cấp LOGIN cho `udp_s1`, `udp_s2` và `udp_s3`, ghi năm chuỗi role vào `.env.ci`
   (pooled của ba role, cộng chuỗi session của `udp_s2` và `udp_s3` cho kênh LISTEN).
3. `gh secret set -f .env.ci` — nạp cả bảy chuỗi lên GitHub.

Thêm một chuỗi kết nối mới (như `DATABASE_URL_S3_DIRECT` ở Plan #17) thì chạy lại
bước 2 và 3 trước khi push, không thì CI thiếu secret và `test:scratch` dừng ngay ở
bước kiểm biến.

Mỗi lượt CI dựng database `udp_scratch_ci_<run_id>_<run_attempt>` rồi xoá; job bị huỷ giữa
chừng cũng được dọn bởi bước cuối. Lượt hằng đêm giữ project free của CI không bị tạm dừng.
Trong lúc CI đang chạy vẫn chạy `pnpm test` cục bộ được, vì hai project có ngân sách kết nối riêng.

## Lưu ý bảo mật

Dự án xử lý credential cloud thật. **Không bao giờ commit** `.env`, `kubeconfig`,
`service-account*.json` hay bất kỳ khóa riêng nào — `.gitignore` đã chặn sẵn, nhưng hãy
kiểm tra lại trước mỗi lần push.
