# Plan #50 — PLAN (theo `plan50-spec.md` v1) — XONG 29/09/2026

| Pha | Làm gì                                                                                                                      | Cổng                                        |
| --- | --------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| P1  | `@udp/design-lint`: `src/adapter-commit.ts` (thuần), `src/i28-gate.ts` (git), `scripts/i28.ts`; E1 dùng lại `toolDirOf`     | test design-lint (thuần + repo git tạm), E1 |
| P2  | `@udp/db/seed-constants`: email, mật khẩu, SERVER key của seed; `seed.ts` dùng lại                                          | typecheck `@udp/db`, test deploy            |
| P3  | `deploy/e2e/smoke.e2e.test.ts` + `vitest.e2e.config.ts` + script `e2e`                                                      | typecheck, lint                             |
| P4  | `@udp/experiments`: `src/e9.ts` (thuần), `scripts/e9.ts`                                                                    | test experiments                            |
| P5  | `.github/workflows/ci.yml`: job `i28`, job `kind` (E2E, E9 ở làn đêm, chẩn đoán khi đỏ); `deploy/tests/ci-workflow.test.ts` | test deploy                                 |
| P6  | Sổ nợ E2 + E9 (41); thiết kế §13.5, §14.1, §16, D-P38; README `deploy/`; tiến độ bàn giao; commit                           | design-lint, prettier, lint                 |
