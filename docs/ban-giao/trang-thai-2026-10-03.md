# Bàn giao — UDP, 03/10/2026

Tài liệu này đọc được mà không cần phiên làm việc nào. Nó thay `trang-thai-2026-10-02.md` ở vai "điểm bắt đầu cho
người tiếp theo"; tệp đó giữ nguyên phần 61d-1 và phần phát hiện về mốc giờ sự kiện. Nguồn sự thật của thiết kế là
`docs/UDP_design.md`; của phép đo là `docs/measurements/` (nợ trong `kiem-chung-con-no.md`); của từng plan là
`docs/plans/`.

**Trạng thái một câu:** Plan #61 đã xong 61a, 61b, 61c, 61d-1 và **61d-2a** — lời báo của pipeline giờ mang token OIDC
của chính lượt chạy CI, token đó dùng đúng một lần do database cưỡng chế, và ba nhà cung cấp SaaS (GitHub Actions,
GitLab CI, CircleCI) đã nối đủ. Còn 61d-2b (bộ ký trong cụm + Trusted Deploy cho ba CI trong cụm), 61d-3 (Kyverno),
rồi Plan #62 (phát hành SDK). 49 mục nợ kiểm chứng. Hạ tầng của dự án tốn đúng 0 đồng.

## 1. 61d-2a — đã làm

| Phần                  | Nội dung                                                                                                                                                                                                                                             |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Schema                | `WebhookTokenUse` (unique `(issuer, token_id)` tên ghim `webhook_token_uses_once`), cột `domain_configs.oidc_required`, hàm `udp_prune_webhook_token_uses` `SECURITY DEFINER` retention viết cứng, trigger đưa cờ về `false` khi đổi `selected_tool` |
| Xác minh              | `cicd/trusted-deploy.ts`: bảng nhà cung cấp **khai báo**, issuer suy từ cấu hình, JWKS qua `createEgressFetch`, cache giữ bản cũ khi nhà cung cấp hỏng, `jose` ghim RS256 + `maxTokenAge` + `clockTolerance`                                         |
| Dùng một lần          | `cicd/token-use.repository.ts`: `ON CONFLICT DO NOTHING` rồi đếm hàng; `body_digest` phân biệt retry với replay                                                                                                                                      |
| Đường webhook         | `verifyDeployToken` ngoài transaction và sau `verified()`; hai luật cưỡng chế; audit mỗi lần từ chối; 401 terminal vs 503 retryable; nhánh lấy từ CLAIM                                                                                              |
| Công tắc              | tự bật ở token hợp lệ đầu tiên, `PUT /projects/:id/domains/CICD/oidc-required` (MAINTAINER, có tiền điều kiện), reset bằng trigger                                                                                                                   |
| Ba adapter            | GitHub xin token trong bước báo (`id-token: write` luôn có); GitLab khai `id_tokens:` ở mức YAML; CircleCI dùng `$CIRCLE_OIDC_TOKEN_V2`. Header Bearer viết MỘT chỗ trong `notifyScript`                                                             |
| Portal                | in `webhookUrl` của máy chủ thay vì tự ghép ở trình duyệt; hàng trạng thái Trusted Deploy nói đúng lý do khi chưa khả dụng; nút bật/tắt cho MAINTAINER; mock của bản xem thử có route mới                                                            |
| `AppDeps.egressFetch` | thêm vào tiến trình API (trước đó chỉ worker có), kèm sentinel `noEgress` cho 24 chỗ dựng app trong test                                                                                                                                             |
| Tài liệu              | §1.2, §2.1 ERD, §2.2 (bảng mới + cột mới), §2.3, §8.3 đoạn `[v4.12] 61d-2a` kèm bảng nhà cung cấp, §12.1 T6 lớp thứ ba, §16 ba dòng, bất biến **I41**, sổ nợ `trusted-deploy-real`                                                                   |
| Test                  | `trusted-deploy` 22 ô tất định; `cicd-webhook` 37 ô (7 ô Trusted Deploy qua HTTP + database thật, 6 ô cho route bật/tắt); `wire-golden` 124; design-lint 162 (sổ kép bảng nhà cung cấp, retention bảng token)                                        |

## 2. Ba quyết định đáng nhớ, và vì sao

- **KHÔNG dùng `createRemoteJWKSet` của `jose`.** Nó đi `fetch` toàn cục, mà luật của repo
  (`cluster-access/src/transport.ts`) là Service 1 gọi URL do người dùng nhập thì phải đi `createEgressFetch` — có
  chặn SSRF ngay trong `lookup` để không hở DNS rebinding. Issuer GitLab đến từ `tool_config.gitlabUrl` và regex của
  nó NHẬN cả `https://169.254.169.254`. Đã đo rằng `jose.customFetch` tồn tại và dùng được, nhưng tự lấy JWKS còn
  được thêm hai thứ: giữ bản khoá cũ khi nhà cung cấp hỏng, và một đường kiểm tất định.
- **`aud` dùng `CORS_ORIGIN`, không thêm biến mới.** Nó LÀ origin của Portal, tức đúng chuỗi người dùng vẫn copy, và
  đã có tiền lệ ghép URL công khai từ nó. Quan trọng hơn: trước đợt này Portal tự ghép URL ở trình duyệt nên "nguồn sự
  thật duy nhất" cho `aud` **không tồn tại** — phải sửa ba chỗ (biến, hàm ghép ở backend, và bỏ `window.location.origin`
  ở Portal), không phải một.
- **Lần từ chối của Trusted Deploy KHÔNG ghi `DEPLOY_FAILURE`.** Nếu ghi, ai có secret HMAC sẽ bơm được sự kiện hỏng
  vô hạn và làm bẩn Change Failure Rate của DORA. Nó là cổng xác thực nên dấu vết là `AuditLog`, và vì vậy trường
  `trustedDeploy` trên dây chỉ có `VERIFIED` hay `null` — enum được thu hẹp cho đúng sự thật.

## 3. Phát hiện khi làm

- **Tài liệu CircleCI lật một giả định của plan.** `aud` mặc định LÀ `ORGANIZATION_ID` và đổi nó cần một tính năng
  riêng ở mức tổ chức, **không đặt được trong `config.yml`**. Hệ quả bảo mật đã công bố ở §16: với CircleCI, `aud`
  không buộc token vào đúng project — mọi job trong cùng tổ chức đều có token mang đúng `aud` đó — nên việc buộc token
  vào project dựa HOÀN TOÀN vào claim `oidc.circleci.com/project-id`.
- **Bộ hợp đồng CI/CD bắt được một lỗi thật.** Tôi chèn dòng xin token trực tiếp vào mảng của adapter; ở hai trong sáu
  chỗ, phép thụt lề chỉ áp cho kết quả của `notifyScript` nên mấy dòng đó rơi sai cột và sinh **YAML không hợp lệ**.
  Sửa ở gốc: đưa chúng thành tham số của `notifyScript`, rồi thêm `UDP_OIDC_TOKEN` vào danh sách needle của bộ hợp đồng.
- **Cờ `oidcRequired` phải là CỘT RIÊNG, không nằm trong `tool_config`.** Đường ghi duy nhất của `tool_config` là
  `replaceDomains`, vốn `upsert` ghi đè TOÀN PHẦN và chỉ chạy khi project còn sửa được ⇒ cờ sẽ bị xoá im lặng mỗi lần
  lưu cấu hình domain và không bao giờ tự bật được cho project đang chạy. Để ở cột riêng thì lỗi đó biến mất về mặt
  cấu trúc. Tiền lệ và lý lẽ đã có sẵn ở `webhook_secret` (migration Plan #36).
- **Reset khi đổi tool làm bằng TRIGGER, không bằng mã.** `tool_config` không phải đường ghi duy nhất của hàng CICD,
  nên một luật đặt trong một đường ghi là luật mà mọi đường ghi tương lai phải nhớ làm lại. Trigger chỉ bao giờ HẠ cờ
  xuống `false`, không bao giờ bật, nên nó không thể làm một project yếu đi bất ngờ.
- **Bộ hợp đồng dây bắt được một lỗ test của tôi.** Route `PUT /domains/CICD/oidc-required` đi `sendJson` nhưng
  tôi không khai nó trong `ROUTES` của `tests/wire-golden.test.ts`, và sáu ô Trusted Deploy đầu tiên sửa cờ thẳng ở
  database nên KHÔNG ô nào gọi route đó qua HTTP. `wire-golden` đỏ ở đúng phép kiểm "không route sendJson nào thiếu
  dòng trong ROUTES". Sửa bằng cách viết sáu ô HTTP thật (bậc quyền, thân `strict`, idempotent, 409 của tiền điều
  kiện, van xả tắt được kể cả khi `available` đã false, và trigger hạ cờ khi đổi CI) chứ không bằng cách thêm một
  dòng miễn trừ vào `NO_GOLDEN_YET`.
- **Một ô test của tôi sai, và tôi sửa test chứ không sửa mã.** `clockTolerance` 60 giây cố ý cho phép lệch đồng hồ
  giữa CI và UDP, nên một `exp` quá hạn 30 giây vẫn được nhận. Con số lề đó giờ được ghim bằng một phép khẳng định hai
  chiều để nó là tính chất có chủ đích chứ không phải tình cờ.

## 4. Cho người tiếp theo

- **Thêm một nhà cung cấp CI mới:** sửa `TRUSTED_DEPLOY_PROVIDERS` trong `cicd/trusted-deploy.ts` **và** bảng trong
  §8.3 — `packages/design-lint/tests/trusted-deploy-providers.test.ts` khẳng định hai bên bằng nhau, nên thiếu một
  bên là một test đỏ. Và phải xác minh mọi giá trị tại tài liệu của chính nhà cung cấp, không lấy từ trí nhớ.
- **Thêm một mã từ chối:** `TRUSTED_DEPLOY_REJECTIONS` (`packages/shared-types/src/build.ts`), rồi quyết xem nó có
  thuộc `TRUSTED_DEPLOY_RETRYABLE` không (503 vs 401). **Đừng** đưa nó vào `ERROR_CATALOG`: catalog không có mã 401
  nào, và `problem.ts` kiểm số mã LÚC NẠP MODULE.
- **Đổi retention của bảng token:** sửa CÙNG LÚC `CICD_WEBHOOK.tokenUseRetentionDays` và thân hàm
  `udp_prune_webhook_token_uses` — `packages/design-lint/tests/retention.test.ts` chốt hai con số không trôi.
- **Đừng dùng projected ServiceAccount token volume cho 61d-2b.** Token của nó do kubelet cấp và dùng lại suốt vòng
  đời, nên hai lượt build trong cùng một giờ có CÙNG một `jti` và sẽ đập vào chính bảng "dùng một lần".
  `adapter-base/packaging/build-script.ts` đã có `tokenRequestLines(audience, file)` cấp token mới mỗi lần, và Role
  `udp-builder-token` đã cho phép đúng việc đó — đây cũng là chữ của QĐ-17.

## 5. Việc tiếp

**61d-2b** — bộ ký trong cụm cho CircleCI + Azure, **và** Trusted Deploy cho ba CI trong cụm. Quyết định còn mở, và
đầu vào quan trọng nhất đã có: cả hai lối đều chạm phía cụm, và **mọi cụm đều có cùng một chủ thể**
`system:serviceaccount:udp-build:udp-builder` nên chủ thể không nhận diện được project — chỉ issuer làm được. Nghĩa là
toàn bộ bảo mật của lối JWKS-của-cụm nằm ở chỗ issuer được lưu đúng, còn lối TokenReview đòi quyền mới trên cụm khách
cộng một lượt bootstrap lại.

Sau đó: 61d-3 (Kyverno), tài liệu và Playwright cuối Plan #61, rồi Plan #62.
