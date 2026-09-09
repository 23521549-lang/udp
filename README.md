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
│   ├── db/                    Prisma schema, migration, test bất biến tầng DB
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

# 6. Chạy service
pnpm dev:core
```

> Ba service còn lại (`dev:flags`, `dev:pd`, `dev:portal`) và Portal chưa có mã
> nguồn — thư mục mới chỉ được đặt chỗ, chạy các lệnh đó sẽ báo không tìm thấy package.

| Dịch vụ | URL |
| ------- | --- |
| Core Backend | http://localhost:3001 |
| Prometheus | http://localhost:9090 |
| Portal, Flag Service, PD Controller | chưa hiện thực |
| Prisma Studio | `pnpm db:studio` |

## Lệnh thường dùng

| Lệnh | Tác dụng |
| ---- | -------- |
| `pnpm dev:infra` / `pnpm dev:infra:down` | Bật/tắt Prometheus |
| `pnpm db:migrate` | Tạo và áp dụng migration |
| `pnpm db:generate` | Sinh lại Prisma Client sau khi sửa schema |
| `pnpm db:seed` | Nạp dữ liệu mẫu (idempotent) |
| `pnpm db:studio` | Mở giao diện xem dữ liệu |
| `pnpm typecheck` | Kiểm tra kiểu toàn workspace |
| `pnpm test` | Chạy test — gồm bất biến I22/I30/I39 chạy trên database thật |

## Lưu ý bảo mật

Dự án xử lý credential cloud thật. **Không bao giờ commit** `.env`, `kubeconfig`,
`service-account*.json` hay bất kỳ khóa riêng nào — `.gitignore` đã chặn sẵn, nhưng hãy
kiểm tra lại trước mỗi lần push.
