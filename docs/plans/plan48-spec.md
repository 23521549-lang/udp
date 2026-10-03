# Plan #48 — SPEC v1: Golden Path (Create New) và Import Existing Repo

Nguồn: `docs/ban-giao/viec-con-lai-2026-09-28.md` mục 9; §11.1, §11.2, §10.5, §16 hàng "Golden Path chỉ
Node.js và Python", §8.3 (áp image), §6.6 (ba điều kiện của C1).

## 1. Phạm vi

| Thiết kế hứa                                                                                        | Hôm nay                                                       | Plan này                                                              |
| --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- | --------------------------------------------------------------------- |
| §11.1 cây template Node: `src/index.ts`, `src/app.ts`, `src/routes/`, Dockerfile, `udp.yml`, `k8s/` | Chỉ `udp.yml` (`GET …/domains/CICD/pipeline-template`)        | Đủ cây, và bản Python tương đương                                     |
| §11.1 "Manifest của template đặt `OTEL_SERVICE_NAME` và `service.version`… CI ghi image tag"        | Luồng áp image §8.3 chỉ đổi `image` — `service.version` cũ đi | Nhãn pod `app.kubernetes.io/version` theo image, manifest đọc nhãn đó |
| §11.2 quét repo 8 bước, chỉ đề xuất, cờ "chưa sẵn sàng cho flag-level rollout" trên dashboard       | Wizard chỉ lưu `repoUrl`                                      | Quét GitHub/GitLab công khai, lưu kết quả, thẻ trên Tổng quan         |
| Pipeline của Golden Path chạy test của ứng dụng                                                     | Sáu template ghim `npm test` — sai với project Python         | Lệnh test theo runtime                                                |

## 2. Quyết định

### QĐ-1: Template là dự án THẬT, chạy được trong monorepo

§11 là mã developer chép thẳng; v3 đã phát tán một cơ chế không chạy (baggage OTel). Nên template không
phải chuỗi văn bản: `packages/golden-path/templates/node` được typecheck, lint và khởi động trong test của
`@udp/golden-path` (supertest: `/healthz`, `/metrics` có histogram và nhãn `ff` khi flag được track);
`templates/python` (FastAPI) được ruff, mypy và pytest trong job CI `python`. Tệp cấu hình mà công cụ của
monorepo sẽ hiểu nhầm mang đuôi `.tmpl` (`package.json.tmpl`, `tsconfig.json.tmpl`) và mất đuôi khi sinh.
Mã nguồn template chỉ import entry CÔNG KHAI của provider (design-lint cưỡng chế, như sample-app).

### QĐ-2: Sinh = đọc cây template + thay đúng hai dấu hiệu

`goldenPathFiles({ runtime, slug, registryRef })`: `golden-path-app` ⇒ slug của project (tên package,
workload, container, `OTEL_SERVICE_NAME` mặc định), `REGISTRY_REF` ⇒ registry của binding `registry.oci`
(hoặc giữ nguyên khi chưa có), phiên bản `workspace:*` của provider ⇒ phiên bản phát hành. Thêm `udp.yml`
(hoặc tệp tương ứng) từ adapter CI/CD đang bật khi có. Runtime ngoài `nodejs`/`python` ⇒ 422 (§16).
Template đọc cấu hình từ biến môi trường, nên mã không mang dấu hiệu nào — code chạy được nguyên văn.

### QĐ-3: `service.version` luôn khớp image đang chạy

Manifest template: `SERVICE_VERSION` từ nhãn pod `app.kubernetes.io/version` (Downward API), rồi
`OTEL_RESOURCE_ATTRIBUTES=service.version=$(SERVICE_VERSION)`. Patch image của S1 (§8.3, cả lúc áp lẫn lúc
rollback) gắn nhãn đó = tag của image (ký tự nhãn hợp lệ, ≤ 63; digest ⇒ 12 chữ số hex đầu). Không có
nhãn thì `service.version` = chuỗi rỗng ⇒ middleware ghi `unknown`, `probe()` bắt được (§6.6).

### QĐ-4: Pipeline chạy test theo runtime

`PipelineTemplateParams.languageRuntime` (thêm, §5.2): `nodejs` ⇒ `npm ci && npm test`, `python` ⇒
`pip install -r requirements.txt && pytest -q`, khác ⇒ bước test báo thiếu lệnh rồi dừng pipeline (thất bại
rõ ràng hơn một pipeline xanh không test gì). Lệnh tuân luật ký tự của D-P28 (không `'`, `\`, `%`, xuống dòng).

### QĐ-5: Quét repo ở Service 1, qua HTTPS công khai (chi phí 0)

`POST /projects/:id/repo-scan` (DEVELOPER) đọc `repoUrl` của project: GitHub (API cây một lời gọi + tệp
thô) hoặc GitLab (API cây + tệp thô), `token` tuỳ chọn trong thân cho repo riêng tư — dùng cho lượt quét
đó, không lưu. Trần: 20 000 mục cây, 60 tệp đọc, 256 KiB mỗi tệp, 15 giây mỗi lời gọi. Host khác ⇒ 422 nói
rõ chỉ quét được GitHub/GitLab. Bộ quét là hàm THUẦN ở `@udp/golden-path` trên một `RepoSource` (liệt kê +
đọc), test bằng nguồn trong bộ nhớ; nguồn mạng đi qua `AppDeps` để test S1 tiêm bản giả.

Tám bước §11.2 thành các phát hiện có trạng thái `ok | missing | unknown` và đề xuất kèm nội dung (Dockerfile
của Golden Path cho runtime nhận diện, pipeline của adapter đang bật, đoạn mã provider/middleware). Kết quả
mới nhất lưu ở cột `projects.repo_scan` (JSONB); `flagLevelReady` = có provider UDP VÀ có middleware.
Không bao giờ ghi vào repo của developer.

### QĐ-6: Portal

- Trang "Golden Path" (project CREATE_NEW): cây tệp, xem từng tệp, sao chép, tải `.zip` (bộ ghi zip "store"
  tối giản trong Portal, không thêm phụ thuộc).
- Trang "Tích hợp repo" (project IMPORT_EXISTING): kết quả quét, nút quét lại (ô token tuỳ chọn), đề xuất
  từng mục — developer duyệt từng đề xuất, không có nút "áp".
- Tổng quan: thẻ "Sẵn sàng cho flag-level rollout" (IMPORT_EXISTING): chưa quét / sẵn sàng / chưa sẵn sàng
  kèm hai dòng thiếu.

## 3. Tiêu chí chấp nhận

- **AC-1** Template Node khởi động trong test: `/healthz` 200, `/metrics` có
  `http_server_request_duration_seconds` với `ff="<flag>=<variant>"` khi flag được track.
- **AC-2** Template Python qua ruff, mypy, pytest (TestClient) với cùng khẳng định.
- **AC-3** `goldenPathFiles` sinh đủ cây §11.1 cho hai runtime, không còn dấu hiệu nào; runtime khác ⇒ lỗi.
- **AC-4** Patch image gắn nhãn phiên bản (áp và rollback); pipeline test theo runtime ở cả sáu adapter.
- **AC-5** Quét: nhận diện runtime/framework, Dockerfile, `/metrics`, OpenFeature, provider + middleware UDP,
  `service.version` trong manifest, công cụ CI/CD; `flagLevelReady` đúng; GitHub/GitLab; host khác 422.
- **AC-6** Route mới có wire schema, golden fixture và bảng `ROUTES`; Portal ba màn; không thoái cấp.
