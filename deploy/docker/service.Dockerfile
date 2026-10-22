# syntax=docker/dockerfile:1.7
#
# Một Dockerfile cho MỌI service Node của UDP (Plan #49 QĐ-1, QĐ-2):
#   docker build -f deploy/docker/service.Dockerfile \
#     --build-arg PKG=@udp/core-backend --build-arg DIR=services/core-backend -t udp/core-backend:local .
#
# Service chạy MÃ NGUỒN bằng tsx — đúng đường mã mà dev và cả bộ test đã chạy. Bundle thì vỡ registry
# adapter (khám phá adapter bằng import() động trên cây thư mục, §5.3) và mọi tài nguyên đọc theo
# import.meta.url; `node dist/...` thì không chạy được vì gói @udp/* xuất thẳng mã TS.

FROM node:22-alpine AS build
RUN corepack enable
WORKDIR /repo
COPY . .
ARG PKG
# `prisma generate` nạp prisma.config.ts, tệp đó đọc DATABASE_URL_DIRECT — giá trị giả là đủ:
# generate chỉ sinh mã từ schema, không kết nối đi đâu (cùng lý do với job `check` của CI)
ENV DATABASE_URL_DIRECT=postgresql://build:build@localhost:5432/build
RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile --filter "${PKG}..." \
 && if [ -d packages/db/node_modules ]; then pnpm --filter @udp/db generate; fi \
 && pnpm install --frozen-lockfile --prod --filter "${PKG}..."

FROM node:22-alpine
ENV NODE_ENV=production
ARG DIR
COPY --from=build --chown=node:node /repo /repo
WORKDIR /repo/${DIR}
USER node
CMD ["node", "--import", "tsx", "src/index.ts"]
