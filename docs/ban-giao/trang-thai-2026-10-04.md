# Bàn giao — UDP, 04/10/2026

Tài liệu này đọc được mà không cần phiên làm việc nào. Nó thay `trang-thai-2026-10-03.md` ở vai "điểm bắt đầu cho
người tiếp theo"; tệp đó giữ nguyên phần 61d-3 và bài học về cổng `portal-demo`. Nguồn sự thật của thiết kế là
`docs/UDP_design.md`; của phép đo là `docs/measurements/` (nợ trong `kiem-chung-con-no.md`); của từng plan là
`docs/plans/`.

**Trạng thái một câu:** **Plan #61 đã ĐÓNG** (cổng Playwright năm lượt `15 passed`), và **Plan #62 đã xong phần máy
làm được**: hai gói SDK có giấy phép Apache-2.0, metadata đầy đủ, README tiếng Anh, một đường đóng gói **có hợp
đồng** (`scripts/pack.ts`), và hai workflow phát hành bằng **trusted publishing (OIDC)** — npm có provenance, PyPI
có attestation PEP 740, không token dài hạn nào. Còn đúng **một lượt publish thật**, và nó đòi tài khoản của chủ
repo: sổ nợ `sdk-publish-real`. **52 mục nợ kiểm chứng.** Hạ tầng của dự án tốn đúng 0 đồng.

**Một điều phải đọc trước khi tin bảng AC của Plan #62:** AC-6 nửa đầu ("Golden Path hết trỏ tới gói không tồn
tại") **không đạt được trong đợt này** và đã được chuyển thành tiêu chí `**Đạt:**` của mục nợ. Hôm nay
`PROVIDER_RELEASE = "^0.1.0"` và `udp-openfeature[metrics]>=0.1,<1` vẫn trỏ tới hai gói chưa tồn tại, nên một người
đi hết Golden Path vẫn nhận 404 ở `npm install`. Đợt này dựng xong **đường** để chữa, chưa chữa.

---

## 1. Plan #61 đóng — cổng chụp màn bắt một luật sai của chính nó

Lượt đầu đỏ **5/15**, cả năm lượt cùng một dòng: `code-packaging: chữ có "..."`. Đo bằng một script riêng (ngoài
repo) liệt kê từng nút văn bản chứa `...` ⇒ đúng một nguồn: `<code class="mono">go test ./...</code>` — lệnh test
mặc định của một repo Go, và là mặc định của **sản phẩm thật** (`build-plan.ts:35`), không phải của lớp giả lập.

Luật sai, không phải dữ liệu sai. `screens.pw.ts` nay kiểm luật đó trên `proseText(page)`: `textContent` của bản sao
`body` đã bỏ `code, pre, kbd, samp, textarea, input`. Dùng `textContent` nên luật **mạnh hơn** trước ở một chiều
(thấy cả chữ đang ẩn); đã kiểm trước rằng chiều đó không làm đỏ giả (`apps/portal/src` chỉ có 3 chỗ chứa `...`, cả
ba trong chú thích mã). `15 passed (8.9m)`. Chú thích của job `portal-demo` trong `ci.yml` được sửa cho khớp luật
mới — một cổng nói sai về chính nó là một cổng người sau sẽ tin sai.

---

## 2. Plan #62 — ba đợt, và dữ kiện nào quyết định từng đợt

### 62a — thứ phải có trước khi một gói rời khỏi máy

- **Giấy phép Apache-2.0 trên HAI GÓI, không ở gốc repo.** `packages/openfeature-provider/LICENSE` và
  `sdks/python/LICENSE`, nguyên văn tải từ apache.org (202 dòng,
  `sha256 cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30`). Apache-2.0 chứ không MIT vì gói chạy
  TRONG tiến trình của khách và hệ sinh thái OpenFeature là Apache-2.0 (CNCF); điều khoản bằng sáng chế là thứ bên
  pháp lý của người tích hợp sẽ hỏi. **Không** ở gốc repo vì giấy phép là tuyên bố về thứ được PHÁT HÀNH, và đợt này
  phát hành đúng hai gói — một `LICENSE` ở gốc là tuyên bố mở nguồn cả nền tảng, một quyết định về tài sản của khoá
  luận chứ không phải một bước kỹ thuật.
- **Hai dòng KHÔNG viết, vì đo ra là vô tác dụng.** `files: ["dist", "LICENSE"]` và `license-files = ["LICENSE"]`:
  npm/pnpm luôn đưa `LICENSE` + `README.md` vào tarball bất kể `files`, và glob mặc định của setuptools đã nhặt
  `LICENSE` vào `*.dist-info/licenses/` (đo với và không có dòng đó: METADATA giống nhau từng dòng). Một dòng vô tác
  dụng dạy người đọc rằng danh sách đó là đầy đủ. **Nhưng `NOTICE` thì KHÔNG tự vào tarball npm** — nếu một ngày
  cần, nó phải khai tường minh.
- **README tiếng Anh** cho cả hai gói (gói Node trước đây **không có** README nào). Lý do: README là **trang gói**
  trên npm/PyPI, người đọc là người tích hợp OpenFeature. Tài liệu thiết kế vẫn tiếng Việt, và README trỏ về đó bằng
  URL tuyệt đối. Cả hai nói cả **giới hạn**: không fail-closed, `./testing` không có trong bản phát hành, regex chỉ
  nhận ngữ pháp khả chuyển.

### 62b — đường phát hành, và các cổng

- `scripts/pack.ts`: build → `pnpm pack` → xoá `@udp/*` và `scripts` → `npm pack` → **khẳng định hợp đồng, ném nếu
  lệch**. `tests/package.test.ts` nay **gọi chính script đó**, nên thứ được kiểm là đúng bytes được phát hành.
- `publish.yml` (tag `sdk-v*`) và `publish-rehearsal.yml` (chỉ chạy tay, không `id-token`, không environment) — hai
  tệp, không một `if:`.
- Cổng mới: `package-boundaries.test.ts` (đúng một package workspace không `private`; `files` đúng `["dist"]`;
  license/repository/LICENSE/README; lockstep version; hai ghim Golden Path), `ci-workflow.test.ts` (11 ô về cấu
  trúc hai workflow), và `build.ts` tự chặn khi `THIRD_PARTY_NOTICES` lệch bundle.

### 62c — tài liệu

§6.8 (ba gạch đầu dòng, cộng một chỗ **tự trích sai §16** đã sửa), §11, §13.5, §16 (hai dòng sửa + hai dòng mới),
và mục nợ `sdk-publish-real` với runbook sáu bước.

---

## 3. Năm dữ kiện đo được đã BẺ bản nháp của plan — đọc trước khi sửa gì ở đường này

Ba agent QA chạy song song trên bản nháp; mỗi cáo buộc quyết định đã được tự kiểm lại trên lệnh thật. Năm cái nặng
nhất, mỗi cái đổi một quyết định:

1. **Node 22 KHÔNG BAO GIỜ có npm ≥ 11.5.1.** `node -e` đọc `node_modules/npm/package.json` của chính bản Node:
   `v22.20.0 => 10.9.3`, và bản mới nhất của dòng (v22.23.3) kèm 10.9.9. Trusted publishing đòi **≥ 11.5.1**. Nếu
   không ghim npm tường minh, job phát hành đỏ ở **bước cuối**, sau khi chốt duyệt tay đã tiêu. Nên `publish.yml` có
   `npm install -g npm@11.21.0 --ignore-scripts` — **không** `@latest`: `@latest` là một tarball không ghim tải vào
   đúng job đang cầm quyền publish. Đây là chỗ **duy nhất** trong repo ghim một công cụ ở workflow; đừng xoá nó "cho
   khớp quy ước `packageManager`".
2. **`pnpm pack` KHÔNG xoá `@udp/*`** — nó đổi `workspace:*` thành version cục bộ (`"@udp/config": "0.1.0"`), nên
   manifest phát hành trỏ tới **sáu gói không tồn tại trên npm**, và nó giữ `scripts`. Vá bằng
   `publishConfig.devDependencies: {}` **không chạy**: pnpm 9.12.0 chỉ nâng một tập khoá biết trước (đo trên probe
   riêng — `publishConfig` còn nguyên trong manifest đóng gói, `devDependencies` giữ y cũ, chỉ `main` được nâng).
   Vì thế mới có bước dẫn xuất trong `scripts/pack.ts`.
3. **`npm publish --dry-run` KHÔNG bắt `private: true`** (`+ udp-priv-probe-xyz@0.0.1`, exit 0) và **không** diễn
   tập provenance — cả hai phép kiểm nằm sau nhánh `if (!dryRun)`. Nên mọi cổng về hình dạng manifest đọc **manifest
   đã đóng gói**, và tệp diễn tập chỉ hứa đúng thứ nó chứng minh được.
4. **`twine check` exit 0 dù thiếu `long_description`** ("PASSED with warnings"); `--strict` thì exit 1. Và
   `twine check` **không biết gì về giấy phép**: xoá tệp `LICENSE` của gói Python ⇒ `python -m build` **exit 0**,
   `twine check --strict` **PASSED**, METADATA vẫn tuyên bố `License-Expression: Apache-2.0`, mà wheel **không mang**
   giấy phép. Bốn phép kiểm `License-File` / `dist-info/licenses/LICENSE` / `/LICENSE` trong sdist là chỗ **duy
   nhất** bắt được — đã chứng minh bằng một lượt xoá tệp thật.
5. **npm mặc định CHỈ cho `npm stage publish`** với cấu hình trusted publisher tạo từ **03/09/2026**; muốn
   `npm publish` thì phải **tích thêm** ở trang gói. Hôm nay là sau mốc đó, nên bỏ bước này là lượt phát hành đầu đỏ
   ở registry sau khi đã duyệt tay. Nó là bước 4 của runbook trong sổ nợ.

Cộng hai món nhỏ mà cùng loại: `pnpm --filter <pkg> pack` **không chạy** (`ERROR Unknown option: 'recursive'`) —
phải `pnpm -C <dir> pack`; và `pnpm --filter X test typecheck` chỉ chạy `test` rồi truyền `typecheck` làm **tham
số** cho vitest, nên script `typecheck` không bao giờ chạy.

**Một cáo buộc đã bác:** `packages/golden-path/tests/scan.test.ts:123` ghim `"^0.1.0"` — đó là fixture của manifest
**của khách**, và bộ quét khớp theo **tên gói** (`scan.ts:358`), không đọc version. Đổi nó sang `PROVIDER_RELEASE`
sẽ ngụ ý sai rằng bộ quét quan tâm version.

**Một đề xuất chỉ nhận một nửa:** khẳng định tarball bằng **đúng tập 11 entry**. Không được —
`dist/chunk-SRD43SET.js` mang **hash nội dung** trong tên, nên tập chính xác sẽ đỏ ở mọi lần đổi mã, và một cổng đỏ
vì lý do sai sẽ bị tắt. Lấy phương án lùi: allowlist ba tệp gốc + tiền tố `dist/`, cộng hai khẳng định dương.

---

## 4. Một cổng đã ĐỎ trước đợt này mà không ai biết

`ruff format --check` của job CI `python` cũng định dạng **khối Python trong `sdks/python/README.md`**, và bản
README cũ (commit `dca2fdc`, trước Plan #62) đã lệch ở đúng một dòng — comment căn lề bằng nhiều dấu cách:

```
$ git show dca2fdc:sdks/python/README.md > /tmp/README.md && ruff format --check --config pyproject.toml /tmp/README.md
1 file would be reformatted
```

Đã sửa trong đợt này (đưa comment lên dòng riêng, để `ruff format` và `prettier` cùng chấp nhận). Bài học **cùng
hình dạng** với `evidence.test.tsx` ở cuối Plan #61: một cổng đỏ ở một package mình không chạy sẽ ở đỏ rất lâu. Bộ
cổng của repo này nằm ở **bảy** chỗ: `@udp/config`, `@udp/design-lint`, `@udp/shared-types`, `@udp/adapter-core`,
`@udp/core-backend`, `@udp/portal`, **và `sdks/python`** (bốn lệnh, không chỉ pytest).

---

## 5. Việc tiếp

1. **Trả nợ `sdk-publish-real`** — runbook sáu bước trong `docs/measurements/kiem-chung-con-no.md`. Thứ tự quan
   trọng: chạy `publish-rehearsal.yml` (cùng số version) cho xanh **trước** khi publish bootstrap, vì một version đã
   đăng thì không thu hồi được. Và khai đúng ba giá trị đã chốt ở cả hai registry: tên tệp `publish.yml`, environment
   `release-npm`/`release-pypi`, và **Allowed actions: `npm publish`** ở phía npm.
2. **Bật Required reviewers** cho hai environment — `environment:` trong YAML **tự nó không là chốt duyệt nào**.
3. **Hai nhánh chưa merge:** mọi việc của Plan #61 và #62 đang ở nhánh `p61-dong-goi`, chưa push. `workflow_dispatch`
   của tệp diễn tập chỉ xuất hiện sau khi tệp nằm trên nhánh mặc định, nên lượt diễn tập đầu chỉ chạy được sau merge.
4. Còn lại của dự án: các mục nợ cần cloud/cụm/người thật (52 mục), §16 giới hạn đã chấp nhận, §17 hướng mở rộng.
