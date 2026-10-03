# syntax=docker/dockerfile:1.7
#
# Job `udp-migrate` (Plan #49): chuỗi migration, rồi bật LOGIN và đặt mật khẩu cho ba role service từ
# Secret của cluster, rồi seed dữ liệu demo khi `UDP_SEED=true`. Chạy lại được: migrate deploy bỏ qua
# migration đã áp, ALTER ROLE đặt lại cùng mật khẩu, seed là upsert.
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
CMD ["sh", "-c", "node_modules/.bin/prisma migrate deploy && node --import tsx scripts/cluster-bootstrap.ts && if [ \"$UDP_SEED\" = \"true\" ]; then node --import tsx prisma/seed.ts; fi"]
