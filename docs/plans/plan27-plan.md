# Plan #27 — PLAN (theo `plan27-spec.md` v1)

## P1 — Catalog từ registry (Service 1)

| Làm gì                                                                                                              | Ở đâu                                                         |
| ------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| `describeConfigSchema(zod)` thuần ⇒ `configFields`                                                                  | `modules/domain/config-fields.ts`                             |
| `buildCatalog(rows, registry)`: 16 hàng của bảng + tool của registry (id, version, scope, capability, configFields) | `modules/domain/domain-catalog.service.ts`                    |
| `AppDeps.domains` (registry); bản thật nạp `src/modules`; `index.ts` kiểm registry ↔ catalog trước khi mở cổng      | `core/app-deps.ts`, `index.ts`                                |
| `GET /domains/catalog` (đăng nhập), schema dây, golden                                                              | `modules/domain/domain.controller.ts`, `shared-types/wire.ts` |

**Cổng P1:** test thuần configFields; tích hợp catalog + I28 dương tính (thư mục tạm); golden.

## P2 — Domain của project (Service 1)

| Làm gì                                                                                      | Ở đâu                                         |
| ------------------------------------------------------------------------------------------- | --------------------------------------------- |
| Body PUT/validate (zod, `.strict()`) một nguồn cho Portal và S1                             | `shared-types/src/domain-api.ts`              |
| `targetAdapters(body, registry)` + `validationView(result, catalog)` (suggestedAction QĐ-5) | `modules/domain/domain-target.ts`             |
| Đọc/ghi: danh sách theo catalog, upsert có khoá version, thay preference                    | `modules/domain/domain-config.store.ts`       |
| Năm route: GET list, GET :type, GET :type/drift, POST validate, PUT                         | `modules/domain/project-domain.controller.ts` |

**Cổng P2:** test thuần validationView (bảy mã), tích hợp (AC-3..6), golden, I10.

## P3 — Portal

Trang `/app/projects/$projectId/domains` (DomainPanel dùng chung với wizard bước 3), chi
tiết `/domains/$type`, `/admin/catalog`; query key `catalog`, `domains`, `domain`,
`domainDrift`; chữ cho bảy mã. **Cổng:** test Portal với golden, I38, design-lint, build.

## P4 — Đóng plan

§10.15 D-P (`:type`, gộp preferences, không rebindPlan, PUT chỉ DRAFT); sổ nợ trả
`domains-catalog-route`, `portal-domain-screens`, viết lại `domain-day2-route`; bàn giao.
