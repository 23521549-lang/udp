# syntax=docker/dockerfile:1.7
#
# Job `udp-migrate` (Plan #49): chuỗi migration, rồi bật LOGIN và đặt mật khẩu cho ba role service từ
# Secret của cluster, rồi đồng bộ `domain_catalog` (dữ liệu nền tảng — LUÔN chạy, không phụ thuộc
# UDP_SEED), rồi seed dữ liệu demo khi `UDP_SEED=true`. Chạy lại được: migrate deploy bỏ qua
# migration đã áp, ALTER ROLE đặt lại cùng mật khẩu, sync catalog và seed đều là upsert. Seed tự đồng bộ catalog
# lần nữa bằng cùng hàm (Plan #64 64e) vì nó còn chạy ở những đường không qua job này - lần thứ hai không đổi gì.
#   docker build -f deploy/docker/migrate.Dockerfile -t udp/migrate:local .

FROM node:22-alpine
RUN corepack enable
WORKDIR /repo
COPY . .
ENV DATABASE_URL_DIRECT=postgresql://build:build@localhost:5432/build
RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile --filter "@udp/db..." \
 && pnpm --filter @udp/db generate \
 && chown -R node:node /repo
# Giá trị giả của lúc build không được sống sang lúc chạy — cluster đặt giá trị thật
ENV DATABASE_URL_DIRECT=
WORKDIR /repo/packages/db
USER node
CMD ["sh", "-c", "node_modules/.bin/prisma migrate deploy && node --import tsx scripts/cluster-bootstrap.ts && node --import tsx scripts/sync-catalog.ts && if [ \"$UDP_SEED\" = \"true\" ]; then node --import tsx prisma/seed.ts; fi"]
