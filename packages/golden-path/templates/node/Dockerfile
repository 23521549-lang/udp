# Golden Path (§11.1) — build nhiều tầng: tầng chạy chỉ có dist/ và phụ thuộc production.
# `npm ci` cần package-lock.json: chạy `npm install` một lần ở máy và commit tệp khoá.
# Image nền ghim digest (tag để đọc): tag đẩy đè được. UDP cập nhật digest theo bản vá của Node 22.
FROM node:22.23.3-alpine@sha256:0a7108bf6c7bf5de370ffb1a3ed6be93d405b43ff159f681a8d18c0e2bc2e402 AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:22.23.3-alpine@sha256:0a7108bf6c7bf5de370ffb1a3ed6be93d405b43ff159f681a8d18c0e2bc2e402
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
USER node
EXPOSE 3000
CMD ["node", "dist/index.js"]
