# syntax=docker/dockerfile:1.7
#
# Portal (Plan #49): build tĩnh bằng Vite, phục vụ bằng nginx KHÔNG root (cổng 8080). [Plan #60] `build:static`
# thêm lượt SSR dựng sẵn trang giới thiệu (index.html) và vỏ SPA (app.html), cùng llms.txt, index.md. Nginx proxy
# `/api` sang Service 1 — cùng origin với Portal nên cookie httpOnly đi kèm mà không cần CORS (§10.10).
#   docker build -f deploy/docker/portal.Dockerfile -t udp/portal:local .

FROM node:22-alpine AS build
RUN corepack enable
WORKDIR /repo
COPY . .
RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile --filter "@udp/portal..." \
 && pnpm --filter @udp/portal run build:static

FROM nginxinc/nginx-unprivileged:1.27-alpine
COPY deploy/docker/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /repo/apps/portal/dist /usr/share/nginx/html
EXPOSE 8080
