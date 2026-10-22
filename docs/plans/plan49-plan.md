# Plan #49 — PLAN (theo `plan49-spec.md` v1) — XONG 29/09/2026

| Pha | Làm gì                                                                                                                                           | Cổng                                                   |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------ |
| P1  | `tsx` thành phụ thuộc chạy của S1/S2/S3/sample-app, `start` sửa theo, bỏ `build` sinh `dist/` không chạy được                                    | typecheck, test các service                            |
| P2  | `.dockerignore`, `deploy/docker/{service,portal,migrate}.Dockerfile`, `nginx.conf`; `packages/db/scripts/cluster-bootstrap.ts`                   | typecheck `@udp/db`; build thật ở CI (#50)             |
| P3  | `@udp/config/env-schema` (schema tách khỏi phép parse `process.env`)                                                                             | test `@udp/config`                                     |
| P4  | `deploy/`: `src/cluster.ts` (hằng, Secret, image), `up.ts`, `down.ts`; Kustomize base + overlay kind; `kind/cluster.yaml`; `pnpm deploy:up/down` | test `@udp/deploy` (kustomize thật + schema env), lint |
| P5  | Thiết kế §15.1 (hiện thực), D-P37; README `deploy/`; bàn giao; commit                                                                            | design-lint, prettier                                  |
