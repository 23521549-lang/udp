# UDP — Configurable DevOps Platform

Nền tảng DevOps-as-a-Service cho phép developer tự chọn cloud (BYOC/Managed), tự cấu hình
domain và tool qua self-service portal, với feature flags và progressive delivery tích hợp sẵn.

Khóa luận tốt nghiệp — Huỳnh Ngọc Thuận (23521549), Khoa Mạng máy tính và Truyền thông, UIT.
Tài liệu thiết kế: `UDP_design.md` (v3.0).

## Cấu trúc

```
udp/
├── packages/
│   ├── db/                    Prisma schema — hợp đồng chung của cả 3 service
│   └── shared-types/          Type dùng chung: AdapterResult, Capability, ResolutionDetails
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

# 3. Khởi động PostgreSQL + Prometheus
pnpm dev:infra

# 4. Tạo schema database
pnpm db:migrate

# 5. Chạy service (mỗi lệnh một terminal)
pnpm dev:core
pnpm dev:flags
pnpm dev:pd
pnpm dev:portal
```

| Dịch vụ | URL |
| ------- | --- |
| Portal | http://localhost:5173 |
| Core Backend | http://localhost:3001 |
| Flag Service | http://localhost:3002 |
| PD Controller | http://localhost:3003 |
| Prometheus | http://localhost:9090 |
| Prisma Studio | `pnpm db:studio` |

## Lệnh thường dùng

| Lệnh | Tác dụng |
| ---- | -------- |
| `pnpm dev:infra` / `pnpm dev:infra:down` | Bật/tắt PostgreSQL + Prometheus |
| `pnpm db:migrate` | Tạo và áp dụng migration |
| `pnpm db:generate` | Sinh lại Prisma Client sau khi sửa schema |
| `pnpm db:studio` | Mở giao diện xem dữ liệu |
| `pnpm typecheck` | Kiểm tra kiểu toàn workspace |
| `pnpm test` | Chạy toàn bộ test |

## Lưu ý bảo mật

Dự án xử lý credential cloud thật. **Không bao giờ commit** `.env`, `kubeconfig`,
`service-account*.json` hay bất kỳ khóa riêng nào — `.gitignore` đã chặn sẵn, nhưng hãy
kiểm tra lại trước mỗi lần push.
