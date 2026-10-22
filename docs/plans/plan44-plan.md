# Plan #44 — PLAN (theo `plan44-spec.md` v1) — XONG 28/09/2026

| Pha | Làm gì                                                                                                                                                                                         | Cổng                                   |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------- |
| P1  | `@udp/shared-types`: `replaceVariantsFields` + refine (dùng lại `variantKey`, `FLAG_VALUE_SCHEMAS`), `promote.ts` (dời `planPromotion`, `stableJson`), wire `promoteResponseWire`; test đơn vị | test shared-types                      |
| P2  | S2: `replaceVariants` trong `flag.service.ts` theo QĐ-2/QĐ-4, route `PUT /internal/flags/:id/variants`; test tích hợp AC-1, AC-2                                                               | test S2 (tệp mới + `internal-routes`)  |
| P3  | S1: `flagService.replaceVariants` (client), `replaceVariants` + `promote` ở `flag.service.ts`, hai route, schema body; test tích hợp AC-3, AC-4; golden                                        | test S1 phần chạm, `wire-golden`       |
| P4  | Portal: mục Variant ở chi tiết flag, `PromoteDialog` gọi route; `flag-api`; test; mẫu msw                                                                                                      | Portal `vitest` + `vite build`         |
| P5  | Thiết kế (§9, §16, I40), design-lint `internal-routes`, bàn giao; cổng AC-6; commit                                                                                                            | design-lint, typecheck, lint, prettier |
