# Plan #62 — Kế hoạch: phát hành hai SDK

Spec: `docs/plans/plan62-spec.md`. Mỗi đợt: mã + test + cổng, rồi một commit (chỉ ở máy — không push).

Mỗi mục nêu đủ bốn thứ theo R1 (**làm gì / ở đâu / hệ quả / lan sang đâu**) cộng một dòng **ai dùng nó hôm nay**
(R6). Đợt này chạm 16 tệp, hai manifest phát hành và hai tệp workflow mới ⇒ **trên ngưỡng R2**: ba agent QA đã chạy
trước dòng mã đầu, và phần "Ba vòng QA đã sửa gì" ở cuối ghi lại từng chỗ plan bị bẻ.

---

## 62a — Thứ phải có trước khi một gói rời khỏi máy (AC-1, AC-2, AC-5)

### 62a-1. Hai tệp `LICENSE`

- **Làm gì:** thêm mới hai tệp, cùng **nguyên văn** Apache License 2.0 **tải từ nguồn gốc**
  (`curl -fsSL https://www.apache.org/licenses/LICENSE-2.0.txt`, 202 dòng,
  `sha256 cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30`), không gõ lại một ký tự nào. Phần
  `[yyyy] [name of copyright owner]` của appendix **giữ nguyên** — đó là một khuôn mẫu trong văn bản giấy phép, không
  phải một chỗ trống phải điền; chủ bản quyền được khai ở `author` của manifest.
- **Ở đâu:** `packages/openfeature-provider/LICENSE`, `sdks/python/LICENSE`.
- **Hệ quả:** tarball npm có `package/LICENSE` (pnpm/npm tự đưa vào — đã đo, QĐ-1); wheel có
  `*.dist-info/licenses/LICENSE` (glob mặc định của setuptools — đã đo).
- **Lan sang:** **không** lan sang `files` của manifest và **không** lan sang `license-files` của pyproject (cả hai
  là dòng vô tác dụng, QĐ-1); lan sang hợp đồng artifact của 62a-5 và cổng 62b-2.
- **Ai dùng hôm nay:** `scripts/pack.ts` (62a-5) khẳng định `package/LICENSE` có trong tarball; bốn phép kiểm giấy
  phép của 62b-5 đọc nó trong wheel và sdist.

### 62a-2. Manifest npm phát hành được

- **Làm gì:** bỏ `"private": true`; thêm `license: "Apache-2.0"`, `repository`
  (`{type: "git", url: "git+https://github.com/23521549-lang/udp.git", directory: "packages/openfeature-provider"}`),
  `homepage`, `bugs`, `keywords`, `author`; đổi `description` sang tiếng Anh (nó là dòng mô tả trên trang npm).
  **Không** chạm `files`, **không** chạm `publishConfig` (`./testing` vẫn không có ở đó), **không** chạm `engines`
  (`>=20.11` là tuyên bố về ứng dụng của KHÁCH, không phải về máy build của UDP).
- **Ở đâu:** `packages/openfeature-provider/package.json`.
- **Hệ quả:** `npm publish` không còn bị chặn bởi `private`; provenance có `repository.url` để registry đối chiếu.
  Và vì bỏ `private` là mở một đường trước đây đóng, mọi tính chất nó từng che phải có cổng riêng (62b-2).
- **Lan sang:** `packages/design-lint/tests/package-boundaries.test.ts` (62b-2); `scripts/pack.ts` và
  `tests/package.test.ts` (62a-5); §6.8 và §16 (62c-1).
- **Ai dùng hôm nay:** `scripts/pack.ts`; cổng 62b-2 đọc đúng tệp này; job `npm` so `repository.url` với
  `$GITHUB_SERVER_URL/$GITHUB_REPOSITORY`.

> **Vì sao dám bỏ `private` mà không giữ nó làm "dây bảo hiểm":** trusted publishing ràng quyền publish vào **một
> tên tệp workflow** của **một** repo, nên một lượt `npm publish` ở máy không có cách nào xác thực. Giữ
> `private: true` để chặn một rủi ro đã bị chặn, với cái giá là một manifest nói sai về chính nó (gói đang ở trên
> npm mà package.json bảo nó private), là đổi một tính chất thật lấy một tính chất giả. Và `--dry-run` **không**
> bắt `private` (đã đo), nên dây bảo hiểm đó còn làm mọi lượt diễn tập nói sai.

### 62a-3. `pyproject.toml` phát hành được

- **Làm gì:** thêm `license = "Apache-2.0"` (biểu thức SPDX của PEP 639), `readme = "README.md"`, `authors`,
  `keywords`, `classifiers` (**không** có classifier `License ::` — dùng cùng biểu thức SPDX thì setuptools **ném**,
  đã đo), `[project.urls]` (Homepage, Repository, Documentation, Issues); đổi `description` sang tiếng Anh và bỏ ký
  hiệu `§` của tài liệu nội bộ; nâng `requires = ["setuptools>=77,<85"]`; thêm `build>=1.2,<2` và `twine>=6.1,<7`
  vào extra `dev`. **Không** khai `license-files` (QĐ-1).
- **Ở đâu:** `sdks/python/pyproject.toml`.
- **Hệ quả:** METADATA có `License-Expression`, `License-File` và `Description`; `twine check --strict` xanh;
  `python -m build` và `twine` có sẵn ở CI và ở máy dev qua đúng một lệnh (`pip install -e ".[dev]"`).
- **Lan sang:** job `python` của `ci.yml` (khoá cache là `sdks/python/pyproject.toml` — tự đổi theo, không sửa tay);
  job `build-pypi` của `publish.yml`; cổng lockstep 62b-3 đọc `version` của tệp này.
- **Ai dùng hôm nay:** bốn phép kiểm giấy phép của 62b-5; `twine check --strict` ở cổng 62a.

> **Hai sàn/trần, mỗi cái một chế độ hỏng thật.** `setuptools>=77` vì PEP 639: bản 76.1.0 ném
> `ValueError: invalid pyproject.toml config: 'project.license'`, bản 69.5.1 (sàn hiện tại) ném
> `'project.license' must be valid exactly by one definition (2 matches found)`, bản 77.0.3 thì build sạch — đo trên
> Python 3.11.16 thật. Trần `<85` vì `[build-system] requires` được phân giải từ PyPI **mỗi lần build**, không qua
> lockfile nào: để `>=77` trần trụi là để backend build trôi tự do trong một repo mà Plan #61 vừa ghim mọi thứ theo
> digest. `twine>=6.1` vì bản dưới 6.1 ném `InvalidDistribution` trên `Metadata-Version: 2.4` — chính bản metadata
> mà PEP 639 sinh ra. (`setuptools` **không có** bản `77.0.0`; bản đầu của dòng là `77.0.1`, nên đừng viết `==77.0.0`
> ở đâu cả.)

### 62a-4. Hai README tiếng Anh

- **Làm gì:** thêm mới `packages/openfeature-provider/README.md`; viết lại `sdks/python/README.md` (bản tiếng Việt 40
  dòng hiện có → tiếng Anh). Mỗi README: cài gì (kèm peer/extra), ví dụ chạy được, bảng tuỳ chọn và mặc định,
  middleware đo lường, **giới hạn đã biết** (không có fail-closed; `./testing` không có trong bản phát hành; regex
  chỉ nhận ngữ pháp khả chuyển D-P35), giấy phép, và link **URL tuyệt đối** về `docs/UDP_design.md` §6.8.
- **Ở đâu:** hai đường dẫn trên.
- **Hệ quả:** trang gói đọc được một mình; `long_description` của PyPI có nội dung ⇒ `twine check --strict` xanh.
- **Lan sang:** `sdks/python/pyproject.toml` (`readme`); phần "Phát triển" tiếng Việt của README Python cũ **không
  bị bỏ** — nó thành một mục "Development" ngắn trong README mới, vì nó là cách chạy test của gói.
- **Ai dùng hôm nay:** `twine check --strict` đọc `long_description`; hợp đồng artifact của 62a-5 đòi
  `package/README.md`.

### 62a-5. `scripts/pack.ts` — một đường đóng gói, dùng bởi cả test và workflow

- **Làm gì:** thêm mới một script xuất `packPublishArtifact({ out })`: (1) chạy build; (2) `pnpm pack`; (3) giải
  nén, xoá mọi khoá `@udp/*` khỏi `devDependencies` và xoá `scripts`; (4) `npm pack` thư mục đó; (5) **khẳng định
  hợp đồng artifact** và **ném** nếu lệch — entry gốc đúng tập `{package.json, LICENSE, README.md}`, mọi entry khác
  dưới `package/dist/`, có `dist/THIRD_PARTY_NOTICES`, không `.map`/`.tsbuildinfo`, manifest không `private`, không
  khoá `@udp/*`, không `scripts`, `main`/`types` trỏ `dist/`, `exports` đúng `.` và `./metrics`. Trả đường dẫn
  tarball. Và sửa `tests/package.test.ts` để nó **gọi script này** thay cho hai bước build+pack riêng của nó.
- **Ở đâu:** `packages/openfeature-provider/scripts/pack.ts` (mới), `packages/openfeature-provider/tests/package.test.ts`.
- **Hệ quả:** thứ bộ test tiêu thụ **là đúng bytes** được phát hành. Và ô
  `package.test.ts:102` ("tarball chỉ có dist + manifest") hết đúng sau 62a-1/62a-4 — nó được **đổi tên** và đổi nội
  dung, chứ không chỉ nới luật: một cổng nói sai về chính nó là một cổng người sau sẽ tin sai (đúng bài học cuối
  Plan #61 với job `portal-demo`).
- **Lan sang:** job `build-npm` và tệp diễn tập (62b-1) gọi cùng script; bảng §4 của spec.
- **Ai dùng hôm nay:** `pnpm --filter @udp/openfeature-provider test`; cổng 62a; job `build-npm`.

> **Vì sao allowlist ba tệp + tiền tố, chứ không khẳng định đúng tập 11 entry.** `dist/chunk-SRD43SET.js` mang
> **hash nội dung** trong tên, nên một tập chính xác sẽ đỏ ở mọi lần đổi mã — một cổng đỏ vì lý do sai sẽ bị người
> ta tắt. Allowlist ở gốc + tiền tố `package/dist/` giữ nguyên lời hứa "không có `src/`", và hai khẳng định dương
> (`toContain("package/LICENSE")`, `toContain("package/README.md")`) giữ lời hứa "có giấy phép và có trang gói".

**Cổng 62a:** `pnpm --filter @udp/openfeature-provider test` **&&** `pnpm --filter @udp/openfeature-provider typecheck`
(hai lệnh rời: `pnpm --filter X test typecheck` chỉ chạy `test` rồi truyền `typecheck` làm **tham số** cho vitest ⇒
0 tệp khớp và script `typecheck` không bao giờ chạy); `sdks/python`: `ruff check`, `ruff format --check`, `mypy`,
`pytest -q`, `twine check --strict`; `prettier --check`.

---

## 62b — Đường phát hành OIDC và các cổng (AC-3, AC-4, AC-6, AC-7)

### 62b-1. Hai tệp workflow

- **Làm gì:** thêm mới `publish.yml` (chỉ `on: push: tags: ["sdk-v*"]`) và `publish-rehearsal.yml` (chỉ
  `workflow_dispatch`). Cả hai: `name:` tường minh, `permissions: { contents: read }` ở **cấp workflow**, và mọi job
  khai `permissions` tường minh. `publish.yml` có năm job theo bảng của QĐ-6: `gate` → `build-npm`/`build-pypi` →
  `npm` → `pypi`, hai job cuối `environment: release-npm` / `release-pypi` và `id-token: write`. `publish-rehearsal.yml`
  **không** có `id-token`, **không** có `environment`, và dừng ở `npm publish --dry-run`. Input `version` của tệp
  diễn tập đi qua `env:` chứ không nội suy thẳng vào `run:` (đúng khuôn `I28_BASE`/`I28_HEAD` của `ci.yml`), và chỉ
  dùng để **đối chiếu**, không bao giờ để **ghi** version vào tệp nào.
- **Ở đâu:** `.github/workflows/publish.yml`, `.github/workflows/publish-rehearsal.yml` (cả hai mới).
- **Hệ quả:** phát hành chỉ xảy ra từ một tag, sau khi `ci.yml` đã xanh trên đúng commit đó, sau một chốt duyệt tay;
  không secret nào tham gia. `--provenance`, ghim `npm@11.21.0`, và action PyPI ghim SHA đều nằm ở đây.
- **Lan sang:** **không** chạm `ci.yml` (bốn workflow rời nhau, trigger khác nhau); `deploy/tests/ci-workflow.test.ts`
  (62b-4); `docs/UDP_design.md` §6.8 và §13.5 (62c-1); mục nợ `sdk-publish-real` (62c-2) — tên tệp `publish.yml` và
  tên hai environment là **giá trị đã chốt** mà chủ repo phải khai y nguyên ở hai registry.
- **Ai dùng hôm nay:** cổng cấu trúc 62b-4; và chủ repo chạy `publish-rehearsal.yml` sau khi merge vào `main`.

### 62b-2. Cổng hình dạng manifest phát hành

- **Làm gì:** trong bộ cổng ranh giới package: (a) lấy danh sách thành viên workspace từ `pnpm-workspace.yaml` thay
  cho mảng ba thư mục viết cứng, và khẳng định **số** thành viên tìm thấy khớp số pnpm báo; (b) **đúng một** thành
  viên không `private`, và nó là `@udp/openfeature-provider`; (c) `files` của gói đó **đúng** `["dist"]`; (d) nó có
  `license`, `repository.url`, `repository.directory`, và hai tệp `LICENSE` + `README.md` tồn tại trên đĩa.
  **Không** thêm ô cho `dependencies` rỗng và cho `./testing`: hai mệnh đề đó đã có cổng, và cổng đang có **mạnh
  hơn** vì nó đọc manifest **đã pack** (xem QĐ-11).
- **Ở đâu:** `packages/design-lint/tests/package-boundaries.test.ts`.
- **Hệ quả:** lỗ fail-open im lặng ở `deploy` (thành viên workspace thứ 21, nằm ngoài ba thư mục được quét) đóng
  lại; mọi tính chất mà `private: true` từng che có một ô riêng.
- **Lan sang:** không (bộ cổng này chỉ đọc tệp).
- **Ai dùng hôm nay:** cổng 62b; job `gate`.

### 62b-3. Cổng hai SDK cùng version, và Golden Path khớp version

- **Làm gì:** thêm `projectVersionOf(src)` — bộ đọc `[project].version` của TOML **fail-closed** theo QĐ-9 — và hai
  ô: (a) `version` của `packages/openfeature-provider/package.json` **bằng** `projectVersionOf(sdks/python/pyproject.toml)`;
  (b) `PROVIDER_RELEASE` của `render.ts` và dòng `udp-openfeature[metrics]…` của `templates/python/requirements.txt`
  **đúng bằng chuỗi tính ra** từ version (`^<maj>.<min>.0` và `>=<maj>.<min>,<<maj+1>`), không phải "khoảng có chứa
  version". Cả hai đọc **tệp thật**, và mỗi đầu vào xấu của bảng QĐ-9 có một ô `toThrow()`.
- **Ở đâu:** `packages/design-lint/src/toml-version.ts` (mới), `packages/design-lint/tests/package-boundaries.test.ts`.
- **Hệ quả:** không bump được một gói mà quên gói kia, và không phát hành được một version mà Golden Path không
  nhận. Không thêm dependency nào ⇒ `pnpm-lock.yaml` không đổi.
- **Lan sang:** `packages/golden-path/src/render.ts` **không đổi** ở đợt này (`^0.1.0` đã đúng) — ô (b) là thứ giữ
  nó đúng từ nay.
- **Ai dùng hôm nay:** cổng 62b; job `gate`.

### 62b-4. Cổng cấu trúc hai workflow

- **Làm gì:** thêm một `describe("Publish SDK (Plan #62)")` khẳng định, trên YAML đã `parse()` (không regex trên văn
  bản thô — đúng bài học `chartPinsOf` của Plan #61): `on` của `publish.yml` chỉ có `push.tags === ["sdk-v*"]` và
  **không** có `workflow_dispatch`; `on` của tệp diễn tập chỉ có `workflow_dispatch`; `permissions` cấp workflow của
  cả hai là `{contents: read}`; **mọi** job khai `permissions`; đúng hai job có `id-token: write` và chúng là
  `npm`/`pypi`; tệp diễn tập **không** job nào có `id-token`; `npm`/`pypi` có `environment` khác nhau; thứ tự
  `needs` đúng (`pypi` chờ `npm`); `JSON.stringify(workflow)` **không** khớp `/secrets\./` ở cả hai tệp; bước publish
  npm có `--provenance` và `--access public`; bước ghim npm có version tường minh **không** phải `latest`; mọi
  `uses:` ngoài họ `actions/*` và `pnpm/*` ghim **40 ký tự hex**.
- **Ở đâu:** `deploy/tests/ci-workflow.test.ts`.
- **Hệ quả:** AC-3 và AC-4 thành máy cưỡng chế thay vì nghiệm thu bằng mắt. `actionlint` bị bỏ khỏi plan: nó không
  tồn tại trong repo, và một bản dựng thử đúng hình dạng "dispatch publish thật" cho nó exit 0.
- **Lan sang:** không.
- **Ai dùng hôm nay:** `pnpm --filter @udp/deploy test` ở cổng 62b.

### 62b-5. Bốn phép kiểm giấy phép của artifact Python

- **Làm gì:** thêm một bước cổng sau `python -m build`, đỏ khi thiếu: METADATA của wheel có
  `License-Expression: Apache-2.0` **và** `License-File: LICENSE`; wheel có `*.dist-info/licenses/LICENSE`; sdist có
  một entry `/LICENSE`. Dùng ở **cả** cổng 62a (lệnh tay) và job `build-pypi`.
- **Ở đâu:** `.github/workflows/publish.yml` (job `build-pypi`) và bảng §4 của spec.
- **Hệ quả:** AC-2 có phép kiểm. Hôm nay nó không có: đo trên probe xoá tệp `LICENSE` mà vẫn khai
  `license = "Apache-2.0"` ⇒ build **exit 0**, METADATA vẫn tuyên bố Apache-2.0, wheel **không mang** giấy phép, và
  `twine check` **PASSED**. Một wheel tuyên bố giấy phép mà không mang giấy phép là đúng thứ AC-2 nói phải chặn.
- **Lan sang:** không.
- **Ai dùng hôm nay:** job `build-pypi`; lượt kiểm chứng 62c-3.

### 62b-6. `THIRD_PARTY_NOTICES` phải khớp bundle thật

- **Làm gì:** `scripts/build.ts` truyền `metafile: true` cho esbuild, suy tập package bên thứ ba thật sự vào bundle
  từ `result.metafile.inputs` (đoạn sau `node_modules/`), và **ném** nếu tập đó khác hằng `INLINED` đã khai — kèm
  tên gói lạ trong thông báo. `INLINED` **giữ nguyên** là một hằng khai tường minh.
- **Ở đâu:** `packages/openfeature-provider/scripts/build.ts`.
- **Hệ quả:** AC-2 hết là một lượt suy luận tay. Đo hôm nay: metafile cho đúng `zod` và `murmurhash3js`, khớp hai
  khối của `THIRD_PARTY_NOTICES` — nhưng một `import` mới ở `flag-evaluator` hay `shared-types` sẽ góp một thư viện
  thứ ba vào bundle **mà notices vẫn hai mục**, và artifact phát hành vi phạm điều khoản attribution của chính giấy
  phép QĐ-1 chọn.
- **Lan sang:** không đổi hành vi build khi tập khớp; `esbuild` đã là devDependency.
- **Ai dùng hôm nay:** mọi lượt `build`, tức cả cổng 62a và job `build-npm`.

> **Vì sao giữ `INLINED` khai tường minh chứ không SUY ra từ metafile.** Suy ra thì notices không bao giờ lệch —
> nhưng cũng không bao giờ ai thấy một thư viện mới đã vào bundle. `INLINED` được viết thành một danh sách là một
> **quyết định nhìn thấy được** ("mỗi cái PHẢI có giấy phép đi kèm", chú thích gốc của nó); biến nó thành dẫn xuất
> là bỏ chính tính chất đó (R11). Khai + khẳng định giữ cả hai.

**Cổng 62b:** `pnpm --filter @udp/design-lint test`; `pnpm --filter @udp/deploy test`;
`pnpm --filter @udp/golden-path test`; `prettier --check`; `eslint` trên tệp đã đổi.

### 62b-7. Mỗi ô mới phải ĐỎ được

- **Làm gì:** với từng ô của 62b-2…62b-6, chạy một lượt cố tình làm lệch và ghi **output đỏ thật** vào báo cáo cuối,
  rồi hoàn nguyên: thêm `private` lại; thêm một tệp vào `files`; thêm `./testing` vào `publishConfig.exports` (ô
  **đang có** ở `package.test.ts:126` phải đỏ); đổi version Python thành `0.2.0`; đổi `PROVIDER_RELEASE` thành
  `^0.2.0`; xoá `LICENSE` của `sdks/python`; thêm một `import` kéo một thư viện thứ ba vào bundle; bỏ `--provenance`;
  đổi ghim npm thành `latest`; thêm `workflow_dispatch` vào `publish.yml`.
- **Ở đâu:** thao tác tạm trên tệp thật, hoàn nguyên bằng `git checkout --` (không commit nào ở giữa).
- **Hệ quả:** không có ô nào "xanh vì không bao giờ chạy tới" — đúng lỗi `chartPinsOf` của Plan #61 (ô xanh với 42
  trong 71 chart).
- **Lan sang:** không.
- **Ai dùng hôm nay:** báo cáo cuối của đợt.

---

## 62c — Tài liệu, sổ nợ, kiểm chứng (AC-8)

### 62c-1. Thiết kế — sáu chỗ, không một chỗ

- **Làm gì:**
  1. §6.8 gạch "**[v4.8] Đóng gói**" (`:4638`): tarball nay là `dist/` + manifest + `LICENSE` + `README.md`; hai tệp
     sau vào bằng **luật của công cụ**, không bằng `files`; manifest phát hành là dẫn xuất của `publishConfig` cộng
     một bước xoá `@udp/*` và `scripts`.
  2. §6.8 gạch "**Chưa làm (lộ trình)**" (`:4639`): viết lại thành mô tả đường phát hành thật, và nói rõ phần **còn**
     chưa làm là một lượt publish bootstrap — `Sổ nợ: \`sdk-publish-real\``.
  3. §6.8 gạch "**Cổng:**" của mục con Bản Python (`:4672`): thêm job `gate` của `publish.yml` và `twine check --strict`.
  4. §6.8 `:4661`: sửa chỗ **tự trích sai** — câu "Golden Path phủ Node.js và Python" viện dẫn §16, nhưng §16
     (`:8620`) viết "**chỉ** Node.js và Python".
  5. §16 **hai** dòng: `:8668` ("Provider Python") và `:8670` ("Provider chưa phát hành npm" — mệnh đề "gói còn
     `private`" thành sai ngay sau 62a-2). Cả hai đổi theo cùng công thức: kênh phát hành đã có, còn nợ một lượt
     publish bootstrap, `Sổ nợ: \`sdk-publish-real\``. Thêm **hai dòng mới**: "không có tuỳ chọn fail-closed" (§6.8
`:4629` nói lý do "ghi ở §16" mà §16 không có dòng đó), và "lockstep version chỉ cưỡng chế được trong kho".
  6. §13.5 (CI của chính UDP): thêm một đoạn theo khuôn `:8435`/`:8437` cho workflow thứ tư và thứ năm — trigger,
     năm job, quyền, hai environment, và việc chúng **không** chạy trên push/PR. Cộng một câu vào §11 `:7831`:
     template Node nhận version phát hành lúc render, template Python ghim một **khoảng** phải chứa version đang
     phát hành, và cổng design-lint canh cả hai.
- **Ở đâu:** `docs/UDP_design.md`.
- **Hệ quả:** tài liệu không còn nói một việc đã làm là chưa làm, và không nói một việc chưa làm là đã làm.
- **Lan sang:** `docs/ban-giao/` (bàn giao đợt). **Không** thêm dòng D-P nào: bảng D-P (§10.15) có cột "§10 viết |
  Portal làm", và hai quyết định của đợt này (giấy phép đặt trên hai gói; lockstep) **không** khác chữ của mục nào —
  thiết kế im lặng hoàn toàn về giấy phép. Chúng được ghi thành **văn bản thiết kế** trong §6.8 và §16, nơi chúng
  thuộc về. (`references.test.ts` không đếm `D-P`, nên đây là quyết định về chỗ đặt, không phải về cổng.)
- **Ai dùng hôm nay:** cổng `design-doc`/`references` của design-lint; bàn giao.

### 62c-2. Sổ nợ `sdk-publish-real`

- **Làm gì:** thêm một mục với **đúng sáu trường** mà cổng đòi (`**Vì sao`, `**Tiền đề`, `**Đạt:**`,
  `**Tài nguyên:**`, `**Ảnh hưởng tới kết luận:**`, và đúng một trong `**Lệnh:**`/`**Runbook`/`**Đo:**` — ở đây
  `**Runbook` vì việc trả nợ là nhiều bước), tiêu đề `## sdk-publish-real — …`, và **bump `Số mục hiện tại: 51` →
  `52`**. Runbook phải có, từng bước kèm cách kiểm: chiếm scope `@udp`; một lượt `npm publish` bootstrap; đăng ký
  trusted publisher npm với **Workflow filename `publish.yml`**, **Environment `release-npm`**, và **tích thêm
  "Allowed actions: `npm publish`"** (mặc định của cấu hình tạo từ 03/09/2026 chỉ cho `npm stage publish`); khai
  pending publisher PyPI (`publish.yml`, `release-pypi`) **rồi phát hành ngay** vì pending publisher không giữ chỗ
  tên; bật Required reviewers cho hai environment và kiểm bằng
  `gh api repos/:owner/:repo/environments/release-npm --jq '.protection_rules'`. Trường `**Đạt:**` mang nửa đầu của
  AC-6: Golden Path hết trỏ tới gói không tồn tại, kiểm bằng `pip install udp-openfeature` trong venv trắng và
  `npm install` trên cây Golden Path sinh ra.
- **Ở đâu:** `docs/measurements/kiem-chung-con-no.md`.
- **Hệ quả:** AC-8 có chỗ trả, và §16 trích được bằng dạng chính tắc `Sổ nợ: \`sdk-publish-real\`` (cổng khớp đúng
  dạng đó; viết "xem sổ nợ ..." thì **không** được tính, và vì chiều kiểm là "mã ⊆ sổ" nên nó im lặng chứ không đỏ).
- **Lan sang:** `docs/UDP_design.md` §16 (62c-1).
- **Ai dùng hôm nay:** chủ repo, ngay sau khi đợt này xong.

**Cổng 62c:** `pnpm --filter @udp/design-lint test` (nó đọc cả `UDP_design.md` và `kiem-chung-con-no.md`);
`prettier --check`.

### 62c-3. Kiểm chứng và kiểm thoái cấp (R9, R11)

- **Làm gì:** chạy đủ bảng §4 của spec và dán output thật; dán cả `pip --version`, `twine --version`,
  `setuptools.__version__` của lượt chạy (hai biến ẩn của hai phép đo PEP 639). Rồi soi ngược năm chỗ: (1) bỏ
  `private` có mở đường nào ngoài ý muốn; (2) README/`description` sang tiếng Anh có làm mất thông tin nào mà bản
  tiếng Việt đang mang (so từng mục trước khi xoá); (3) `setuptools>=77,<85` có làm job `python` trên **Python 3.11**
  đỏ (bản sàn — chạy thật, không suy luận); (4) bước xoá `@udp/*`/`scripts` có xoá mất thứ gì khác; (5) `gate` không
  chạy lại bộ test — nó có bỏ mất phép kiểm nào mà `ci.yml` không phủ.
- **Ở đâu:** báo cáo cuối + `docs/ban-giao/`.
- **Hệ quả:** không món nào "xong" mà không có bằng chứng.
- **Lan sang:** không.
- **Ai dùng hôm nay:** báo cáo cuối.

---

## Thứ tự, và vì sao

62a trước vì hai manifest là đầu vào của mọi thứ sau: workflow đọc version từ chúng, cổng đọc hình dạng của chúng,
và `scripts/pack.ts` chỉ khẳng định được hợp đồng khi hai tệp `LICENSE`/`README.md` đã có. 62b sau vì cổng phải kiểm
**trạng thái đã đúng**, không kiểm trạng thái đang sửa. 62c cuối vì tài liệu chỉ nên nói về thứ đã chạy.

**Đường lùi (R10):** mọi mục là tệp mới hoặc trường thêm vào; `git revert` một commit đủ. Thứ không lùi được — một
lượt publish thật — nằm ngoài phạm vi, sau chốt duyệt tay.

---

---

## 62d — Tên công khai `udp-openfeature` (rủi ro tên của QĐ-5 đã xảy ra)

**Dữ kiện khởi phát [04/10/2026]:** form tạo org của npm trả `The organization name 'udp' is not available`. Lý do đo
được: **đã có package `udp@1.0.0`** (tạo 2013) và npm dùng chung một không gian tên cho org và package. Scope `@udp`
**không bao giờ lấy được**, không phải "đang bị ai chiếm".

**Và đó là một dữ kiện tốt:** nó buộc gọi đúng tên hai thứ vốn khác nhau — `@udp/*` là namespace **trong kho** (tám ô
của `package-boundaries.test.ts` dùng chính tiền tố đó để nhận diện package nội bộ), còn gói phát hành cần một tên
**công khai**. Trước đợt này hai thứ bị gộp làm một, và `@udp/` mang nghĩa "nội bộ, **trừ đúng một ngoại lệ**". Sau
đợt này nó là một vị từ toàn phần: `@udp/` ⇒ không bao giờ cài được từ registry nào.

**Vì sao KHÔNG đổi tên trong kho:** chuỗi `@udp/openfeature-provider` nằm ở **42 tệp**, và đổi nó kéo theo cả
`pnpm-lock.yaml` (ba khoá `importers`). Đổi scope nội bộ là đổi một quy ước kiến trúc để giải một vấn đề của registry.

**Tên: `udp-openfeature`** — trùng y hệt tên gói Python trên PyPI. Hợp lệ với npm
(`validate-npm-package-name@7.0.2` → `validForNewPackages: true`), và **không** vướng luật "too similar": sáu biến
thể chuẩn hoá đều 404, còn `udp-client`/`udp-server`/`udp-proxy` và `udp-stencil-component-library` (tạo 16/07/2025)
sống song song với gói `udp` — npm chỉ so **tên chuẩn hoá đầy đủ**, không so tiền tố.

### Dữ kiện nền của bản nháp đã SAI, và vì sao (R7)

Bản nháp viết "pnpm **nâng** `publishConfig.name`" kèm một probe. Phép đo đó **bị nhiễu hai lần**, và vòng QA bác nó:

```
pnpm --version        (cwd = repo)                 →  9.12.0
pnpm --version        (cwd = scratchpad)           →  11.22.0   ← probe chạy ở đây
pnpm -C <scratchpad> --version                     →  11.22.0   ← `-C` phân giải LẠI theo thư mục ĐÍCH
```

Và trên **gói thật**, với **đúng bản repo ghim**:

```
$ pnpm -C packages/openfeature-provider --version
9.12.0
$ pnpm -C packages/openfeature-provider pack --pack-destination …     # sau khi thêm publishConfig.name
udp-openfeature-provider-0.1.0.tgz
  name          = @udp/openfeature-provider        ← KHÔNG được áp
  publishConfig = {'name': 'udp-openfeature'}      ← KHÔNG bị xoá
```

Việc nâng `name` chỉ xuất hiện giữa pnpm 11.16 và 11.22 — một hành vi mới tinh mà repo không có. Thêm nữa, cặp tên
của probe cũ (`@udp/probe-ten` → `udp-probe-ten`) **không phân biệt được hai giả thuyết**: npm/pnpm làm phẳng scope
khi đặt tên tarball, nên cả hai giả thuyết cho cùng một tên tệp.

**Hệ quả nếu ship bản nháp:** `pack.ts` ném `manifest còn publishConfig` ⇒ cổng 62d đỏ ở dòng mã đầu tiên.

**Bài học, cụ thể hơn R7 một bậc:** chạy phép đo bằng **đúng công cụ mà đường thật dùng**, và **in phiên bản ra
trong cùng lệnh**. Một probe ngoài repo là một môi trường khác.

### 62d-1. Khai tên công khai, và ÁP nó ở bước dẫn xuất

- **Làm gì:** (a) thêm `"name": "udp-openfeature"` vào `publishConfig` của manifest — đó vẫn là **nguồn sự thật duy
  nhất** của tên phát hành (R8); (b) ở **bước 3** của `scripts/pack.ts` (chỗ đã xoá `scripts` và `@udp/*`), áp tên
  đó, độc lập phiên bản pnpm:
  - manifest staged **còn** `publishConfig` (pnpm ≤ 11.16): khoá còn lại phải **đúng** `["name"]` — nếu còn
    `main`/`types`/`exports` nghĩa là pnpm thôi nâng chúng ⇒ **ném**; rồi gán `name` và xoá `publishConfig`;
  - manifest staged **không** còn `publishConfig` (pnpm ≥ 11.22): tên phải **đã bằng** `publishConfig.name` của
    manifest NGUỒN ⇒ nếu không, ném.
- **Ở đâu:** `packages/openfeature-provider/package.json`, `packages/openfeature-provider/scripts/pack.ts`.
- **Hệ quả:** phép kiểm `publishConfig !== undefined` cũ ở `assertPublishArtifact` thành **vô nghĩa** (luôn xanh sau
  bước 3) — thứ nó che (pnpm thôi nâng `main`) chuyển sang điều kiện `["name"]` ở trên cộng hai phép kiểm
  `main`/`types` trỏ `./dist/` đã có. Phải ghi rõ trong chú thích, không để lại một dòng chết.
- **Lan sang:** 62d-2 (hợp đồng), `publish.yml` (62d-9), §6.8 (62d-10).
- **Ai dùng hôm nay:** mọi lượt pack; `npm publish --dry-run`.

### 62d-2. Hợp đồng artifact: tên đúng, và KHÔNG byte nào còn `@udp/`

- **Làm gì:** `assertPublishArtifact(entries, manifest, expectedName)` — `expectedName` đọc từ `publishConfig.name`
  của manifest **NGUỒN**. Thêm ba khẳng định: (a) `manifest.name === expectedName`; (b) `name` không có scope
  (`^[a-z][a-z0-9-]*$`); (c) **không tệp `.js`/`.d.ts`/`.md` nào trong tarball chứa chuỗi `@udp/`**.
- **Ở đâu:** `packages/openfeature-provider/scripts/pack.ts`.
- **Hệ quả:** (c) là cổng mạnh nhất của đợt: nó bắt **cùng lúc** banner của `build.ts`, JSDoc lọt vào
  `dist/types/*.d.ts` (thứ IDE của khách hiện khi hover), và README — mà không cần đoán trước danh sách tệp. Đo
  hôm nay: `dist/` chứa **6** lần `@udp/openfeature-provider` và 1 lần `@udp/metrics-provider`.
- **Lan sang:** `scripts/build.ts` (banner), `src/index.ts`, `src/metrics.ts` (JSDoc), `README.md` (62d-6).
- **Ai dùng hôm nay:** `tests/package.test.ts` gọi `packPublishArtifact`.

### 62d-3. Bộ test tiêu thụ phải đi đúng đường của khách

- **Làm gì:** `tests/package.test.ts` cài tarball vào `node_modules/<artifact.manifest.name>` và import đúng chuỗi
  đó; bỏ `PKG = ["@udp","openfeature-provider"].join("/")` và thư mục `node_modules/@udp/`.
- **Ở đâu:** `packages/openfeature-provider/tests/package.test.ts`.
- **Hệ quả:** không sửa thì ô này **vẫn XANH** mà thôi chứng minh điều nó nói — Node phân giải bare specifier theo
  **đường dẫn**, không đối chiếu `name` (đã đo). Nó sẽ kiểm một bố cục npm không bao giờ tạo, còn specifier khách
  thật gõ thì không chạy ở đâu cả. Đúng lúc đó câu §6.8 "thứ được kiểm là thứ được phát hành" thành sai.
- **Lan sang:** §6.8 (62d-10).
- **Ai dùng hôm nay:** cổng 62d.

### 62d-4. Golden Path sinh mã khách: phép thay FAIL-CLOSED

- **Làm gì:** `PROVIDER_PUBLIC_NAME` + một phép thay **có callback**, không phải `replaceAll` thô:
  khớp specifier **trọn** (`(?=["'\`\s;)])`) nên không nuốt `@udp/openfeature-provider-react`; **ném** khi subpath
không nằm trong tập đã phát hành (`""`, `"/metrics"`), kèm tên tệp; và `goldenPathFiles`đòi tổng số lần thay`> 0`cho runtime`nodejs`.
- **Ở đâu:** `packages/golden-path/src/render.ts` (hằng, hàm, và **doc comment `:9-15` nói "chỉ ba chỗ được thay"**
  — nay là bốn), xuất ở `src/index.ts`.
- **Hệ quả:** ba chế độ fail-open bị đóng, mỗi cái đã dựng được lỗi thật ở phía khách:
  `udp-openfeature/testing` → `ERR_PACKAGE_PATH_NOT_EXPORTED` (subpath `./testing` cố ý **không** phát hành);
  `udp-openfeature-react` → `ERR_MODULE_NOT_FOUND`; và "0 lần thay" không còn lẫn với "không có gì cần thay".
  Template **giữ** tên trong kho (`template-provider.test.ts` nhập thẳng `templates/node/src/app.js` qua workspace,
  không chạy cây sinh ra — nên nó xanh, **không cần alias**).
- **Lan sang:** `tests/render.test.ts`; hai wire fixture (62d-8).
- **Ai dùng hôm nay:** `render.test.ts`.

### 62d-5. `render.test.ts`: trỏ lại, KHÔNG xoá

- **Làm gì:** `:62` đổi khoá sang `PROVIDER_PUBLIC_NAME` nhưng **giữ** phép khẳng định ghim `PROVIDER_RELEASE`;
  thêm `expect(manifest).toContain('"udp-openfeature": "^0.1.0"')` — **một chuỗi** bắt cả hai phép thay và thứ tự
  của chúng; thêm nửa phủ định `không tệp nào chứa "@udp/"` cho **cả hai** runtime; thêm một ô khẳng định mọi
  specifier provider trong cây thuộc đúng tập `["", "/metrics"]`.
- **Ở đâu:** `packages/golden-path/tests/render.test.ts`.
- **Hệ quả:** ô chỉ-phủ-định là một cổng yếu — nó XANH cả khi template bỏ hẳn provider, và XANH cho cây Python.
- **Lan sang:** không.
- **Ai dùng hôm nay:** cổng 62d.

### 62d-6. Bốn bề mặt hướng về khách trong mã

- **Làm gì:** (a) `sdk-quickstart.ts` — `npm install @openfeature/server-sdk udp-openfeature`, `from "udp-openfeature"`,
  và chú thích `:5` bỏ tên có scope (trỏ `packages/openfeature-provider` bằng đường dẫn); (b) `rollout-form.tsx:180`
  — đoạn mã trong `role="alert"` mà Portal đưa người dùng dán khi họ **đang bị chặn** tạo rollout mức flag;
  (c) `build.ts:51` banner — dòng đầu của `dist/index.js`; (d) JSDoc `src/index.ts:2,4` và `src/metrics.ts:6` — vào
  `dist/types/*.d.ts`, thứ IDE của khách hiện khi hover.
- **Ở đâu:** bốn tệp trên.
- **Hệ quả:** (c) và (d) do cổng 62d-2(c) bắt tự động; (a) và (b) do cổng 62d-11 bắt.
- **Lan sang:** `apps/portal/tests/landing.test.tsx:126`, `apps/portal/tests/project-ux58.test.tsx:234` (62d-7).
- **Ai dùng hôm nay:** bộ test Portal; hợp đồng artifact.

### 62d-7. Hai ô Portal: khẳng định NGUYÊN DÒNG, không một token

- **Làm gì:** `landing.test.tsx:126` và `project-ux58.test.tsx:234` khẳng định **cả dòng cài**
  (`npm install @openfeature/server-sdk udp-openfeature` / `pip install openfeature-sdk udp-openfeature`).
- **Ở đâu:** hai tệp test đó.
- **Hệ quả:** cách sửa hiển nhiên (đổi token mong đợi thành `udp-openfeature`) **phá mục đích** của ô
  `"mã SDK theo tab: đổi ngôn ngữ là đổi gói cài"`: sau 62d hai tab **dùng chung tên gói**, nên token đó khớp cả
  hai và ô hết phân biệt được. Từ nay thứ phân biệt hai tab là **trình quản lý gói + SDK**, không phải tên provider
  — phải ghi ra, vì đó là một thay đổi về ý nghĩa của cổng.
- **Lan sang:** không.
- **Ai dùng hôm nay:** cổng Portal.

### 62d-8. Bộ quét repo khách, và hai wire fixture

- **Làm gì:** (a) `scan.ts:358` — `hasDependency(ev, ["@udp/openfeature-provider", PROVIDER_PUBLIC_NAME], /udp-openfeature/i)`;
  `scan.test.ts` **thêm** một ô cho tên công khai, **giữ** ô cũ (`:123` là ca "khách cài từ cây cũ"). (b) Hai golden
  `tests/fixtures/wire/{GET,POST}_projects_id_repo-scan.json` mang **nội dung tệp đề xuất** do `goldenPathFiles`
  sinh ⇒ sau 62d-4 response thật đổi mà golden không; ghi lại chúng, và thêm một ô **không cần database** quét thư
  mục fixture đòi không còn `@udp/openfeature-provider`.
- **Ở đâu:** `packages/golden-path/src/scan.ts`, `tests/scan.test.ts`,
  `services/core-backend/tests/fixtures/wire/*.json`, `packages/design-lint/tests/package-boundaries.test.ts`.
- **Hệ quả:** không sửa (a) thì bộ quét báo "chưa dùng SDK" cho **mọi** khách cài từ npm, và `flagLevelReady` chặn
  rollout mức flag — một sai âm im lặng. Không sửa (b) thì Portal dưới mock **và bản demo công khai** tiếp tục hiện
  import cũ, và `wire-golden.test.ts` **không đỏ** vì nó chỉ parse schema.
- **Lan sang:** `apps/portal/demo/mock/goldens.ts` đọc chính hai fixture đó (không sửa mã, chỉ đổi dữ liệu).
- **Ai dùng hôm nay:** `scan.test.ts`; ô quét fixture.

### 62d-9. `publish.yml`: chắn idempotent đọc tên từ manifest

- **Làm gì:** `npm view "$name@$version"` với `name=$(node -p "…publishConfig.name")`, cộng `[ -n "$name" ] || exit 1`.
  Và một câu cạnh `--access public` nói cờ đó **load-bearing**: `/-/package/<tên mới>/visibility` trả
  `{"public":false}`, nên `--provenance` trên một tên CHƯA tồn tại **ném EUSAGE** nếu thiếu cờ.
- **Ở đâu:** `.github/workflows/publish.yml`.
- **Hệ quả:** không sửa thì `npm view "@udp/openfeature-provider@…"` **luôn** 404 ⇒ chắn vô tác dụng ⇒ chạy lại
  cùng một tag nhận `EPUBLISHCONFLICT` và job **ĐỎ**, đúng thứ chính tệp đó tuyên bố nó tránh — và chỉ lộ ra sau khi
  chốt duyệt tay đã tiêu.
- **Lan sang:** `deploy/tests/ci-workflow.test.ts` (62d-11).
- **Ai dùng hôm nay:** cổng cấu trúc workflow.

### 62d-10. Thiết kế, §16, và sổ nợ

- **Làm gì:**
  1. **§6.8** — tiêu đề `:4539` (tên-của-hồ-sơ của gói phát hành); `:4552` subpath; `:4638`/`:4639` (`publishConfig`
     nay khai **hình dạng VÀ ĐỊNH DANH**; hợp đồng artifact thêm TÊN và "không byte nào còn `@udp/`"); `:4668`
     ("gói `udp-openfeature` **trên PyPI**" — sau 62d có hai gói cùng tên); và câu "thứ được kiểm là thứ được phát
     hành" nay đúng theo nghĩa mạnh hơn (62d-3).
  2. **Mã của khách in trong thiết kế**: §6.1 `:3948`, §6.6 `:4419`, §11.1 `:7849`, `:7879` — thiết kế **tự khai**
     (`:7838`, D-P36 `:7793`) rằng đó là "mã developer chép thẳng".
  3. **§11/D-P36 `:7834`** — hợp đồng của `render()` nay là **bốn** phép thay, không ba.
  4. **§3.1** — một câu ghi quy ước: `@udp/*` là namespace trong kho, không gói nào phát hành; gói duy nhất rời kho
     khai tên công khai ở `publishConfig.name`.
  5. **§16 dòng mới**: "tên trong kho khác tên phát hành, và tên phát hành không có scope" — giá phải trả: hai tên
     cho một thứ; **không có vùng chống nhận lầm** (`udp-openfeature-provider`, `udp_openfeature`, `udpopenfeature`
     để trống, trong khi `@udp/*` cho miễn nhiễm trong scope); hướng mở rộng: scope của chính tài khoản.
     Và một mệnh đề phụ cho dòng lockstep `:8676`: hai gói là **hai dự án registry khác nhau trùng tên**, nên một
     lệch chéo ngôn ngữ từ nay **khó thấy hơn**, không dễ hơn.
  6. **Sổ nợ** — ngoài việc đổi chuỗi: tiền đề (a) `:1392` ("scope `@udp` còn trống **và lấy được**") đã bị **đo
     bác**, và nó **không chứa** chuỗi cần đổi nên phép đổi chuỗi bỏ sót nó; ghi lại đúng bài học — **cả bốn phép
     kiểm hôm 03/10 đều mù** đúng cái đã chặn (một package **không scope** tên `udp`). Bỏ bước tạo org, đánh số lại
     runbook, và viết lại bước bootstrap theo 62d-12.
- **Ở đâu:** `docs/UDP_design.md`, `docs/measurements/kiem-chung-con-no.md`, `docs/plans/plan62-spec.md` (một dòng
  quyết định có ngày ở QĐ-5).
- **Hệ quả:** tài liệu thôi dạy một specifier không cài được, ở đúng những chỗ nó tự nhận là mã để chép.
- **Lan sang:** cổng `references`/`debt-ledger`/`design-doc` của design-lint.
- **Ai dùng hôm nay:** cổng design-lint; chủ repo ở bước bootstrap.

### 62d-11. Cổng: bốn đầu, và mẫu đọc hai tầng

- **Làm gì:** trong `package-boundaries.test.ts`: (a) `publishConfig.name` tồn tại, không scope; (b) nó **bằng**
  `PROVIDER_PUBLIC_NAME` đọc bằng chữ từ `render.ts`; (c) nó **bằng** `name` của `sdks/python/pyproject.toml` (đầu
  thứ tư — biến câu "một tên, hai registry" thành bất biến thay vì khẩu hiệu); (d) **không tệp nào dưới
  `apps/portal/src/` chứa `@udp/openfeature-provider`** (một phép quét, không một danh sách tệp — danh sách sẽ lỗi
  ở đoạn mã thứ ba); (e) `quickstartCode("node", …)` trả dòng cài bắt đầu bằng `npm install` và chứa tên công khai
  (nửa dương — nếu chỉ quét văn bản tệp thì **nhánh Python một mình** làm ô xanh). Trong `ci-workflow.test.ts`:
  bước publish và bước chắn `npm view` **không** chứa chuỗi `@udp/`.
  Và **sửa một defect của 62b**: mẫu `/PROVIDER_RELEASE\s*=\s*"…"/` có chú thích nói nó chặn
  `PROVIDER_RELEASE_LEGACY`, nhưng đo ra nó **không** chặn (`so khop = 1`). Thay cả hai hằng bằng một bộ đọc **hai
  tầng**: mốc đối chiếu là phép **đếm định danh thô** (không vỡ vì prettier hay annotation kiểu), tầng một bắt phần
  phải của `=` lỏng, tầng hai đọc chặt và **in nguyên văn thứ nó thấy** khi lạ. Cộng `uses >= 2` — mệnh đề một regex
  thuần không phát biểu được, và nó bắt đúng thoái cấp "bỏ phép thay trong `render()`".
- **Ở đâu:** `packages/design-lint/tests/package-boundaries.test.ts`, `packages/design-lint/src/toml-version.ts`
  (thêm `projectNameOf`), `deploy/tests/ci-workflow.test.ts`.
- **Hệ quả:** mẫu một tầng cho **0 khớp ở 5/10** cách viết thật (annotation kiểu, nháy đơn, template literal, khai
  trong object, ghép chuỗi) — cùng bẫy `chartPinsOf` (42/71): một mẫu đòi hình dạng cố định, thiếu khớp thì im lặng.
- **Lan sang:** không.
- **Ai dùng hôm nay:** cổng 62d.

### 62d-12. Runbook bootstrap: gói giữ chỗ dựng NGOÀI kho

- **Làm gì:** viết lại bước 3 của `sdk-publish-real`. **npm cũng không áp `publishConfig.name`** (đo:
  `npm notice name: @udp/openfeature-provider`), nên `npm publish` từ thư mục gói sẽ phát hành **sai tên** vào một
  scope không ai sở hữu. Và `npm version` trong kho ghi vào `package.json` thật, tạo commit + tag, và làm lệch cổng
  `sdk-version.ts`. Bootstrap chỉ cần **tên tồn tại**: dựng một gói giữ chỗ `0.0.1` ở thư mục ngoài kho, publish
  `--tag bootstrap --access public`, rồi `npm deprecate`.
- **Ở đâu:** `docs/measurements/kiem-chung-con-no.md`.
- **Hệ quả:** `--tag bootstrap` làm `latest` **không được đặt**, nên `npm install udp-openfeature` ETARGET tới khi
  `0.1.0` lên — mong muốn, nhưng phải là một câu trong runbook chứ không phải một ngạc nhiên.
- **Lan sang:** không.
- **Ai dùng hôm nay:** chủ repo.

**Cổng 62d:** `pnpm --filter @udp/design-lint test`; `pnpm --filter @udp/golden-path test`;
`pnpm --filter @udp/openfeature-provider test` **&&** `… typecheck`; `pnpm --filter @udp/portal exec vitest run`;
`pnpm --filter @udp/deploy test`; ô quét fixture của `@udp/core-backend`; `prettier --check`; `eslint`.

**Kiểm thoái cấp (R11) — mỗi ô phải ĐỎ khi làm lệch:** xoá `publishConfig.name`; đặt nó thành một tên **có scope**;
đổi `PROVIDER_PUBLIC_NAME` lệch khỏi nó; đổi `name` của `pyproject.toml` lệch khỏi nó; để lại một
`@udp/openfeature-provider` trong `apps/portal/src/`; bỏ phép thay trong `render()` (cây sinh ra còn `@udp/` **và**
`uses < 2` ⇒ hai cổng cùng đỏ); dùng subpath `/testing` trong template (render **ném**); chép cứng tên cũ lại vào
`publish.yml`; và thêm một chuỗi `@udp/` vào `src/index.ts` (hợp đồng tarball đỏ).

### 62d — đã làm, và bằng chứng (R9)

```
$ pnpm -C packages/openfeature-provider exec tsx scripts/pack.ts --out <dir>
…\packout5\udp-openfeature-0.1.0.tgz
  name = udp-openfeature | publishConfig = None | main = ./dist/index.js | exports = ['.', './metrics']

$ npm publish udp-openfeature-0.1.0.tgz --dry-run --access public
npm notice name: udp-openfeature      version: 0.1.0      total files: 11
+ udp-openfeature@0.1.0
```

Cổng: design-lint **200** ô (trước 198), golden-path **25**, deploy **77** (trước 76),
openfeature-provider **89**, Portal **365**, `sdks/python` ruff + `ruff format` + mypy + 906 ô, prettier sạch.

**Hợp đồng artifact bắt đúng bốn bề mặt ngay lượt chạy đầu** — không phải suy đoán mà là output thật:

```
Error: artifact phát hành không đạt hợp đồng:
  - dist/index.js còn nhắc @udp/            ← banner của esbuild
  - dist/metrics.js còn nhắc @udp/          ← cùng banner
  - README.md còn nhắc @udp/                ← trang gói npm
  - dist/types/index.d.ts còn nhắc @udp/    ← JSDoc, thứ IDE của khách hiện khi hover
  - dist/types/metrics.d.ts còn nhắc @udp/
```

Và cổng `scan.ts` bắt đúng hệ quả mà Agent C gọi tên: ngay khi cây sinh ra đổi sang tên công khai, ô
"cây Golden Path của chính UDP: mọi điều kiện ok" đỏ với `expected [ 'udp-provider' ] to deeply equal []` — tức
bộ quét báo "chưa dùng SDK". Không sửa thì mọi khách cài từ npm bị chặn rollout mức flag.

**Kiểm thoái cấp (R11) — tám lượt làm lệch, tất cả ĐỎ:**

```
xoá publishConfig.name              -> ĐỎ  expected undefined to be defined
đặt tên CÓ scope                    -> ĐỎ  expected '@udp/openfeature' to match /^[a-z][a-z0-9-]*$/
PROVIDER_PUBLIC_NAME lệch           -> ĐỎ  expected 'udp-openfeatures' to be 'udp-openfeature'
tên pyproject lệch                  -> ĐỎ  expected 'udp-of' to be 'udp-openfeature'
để lại @udp/ trong apps/portal/src  -> ĐỎ  expected [ Array(1) ] to deeply equal []
dùng literal thay vì hằng ở render  -> ĐỎ  PROVIDER_PUBLIC_NAME được khai mà KHÔNG được dùng (xuất hiện 1 lần)
bỏ hẳn phép thay trong render()     -> ĐỎ  expected undefined to be '^0.1.0'
template dùng subpath /testing      -> ĐỎ  template dùng subpath "/testing" … sẽ ERR_PACKAGE_PATH_NOT_EXPORTED
thêm @udp/ vào src/index.ts         -> ĐỎ  dist/types/index.d.ts còn nhắc @udp/
chép cứng tên cũ vào publish.yml    -> ĐỎ  (ci-workflow.test.ts)
```

**Vòng R11 bắt được một ô của chính đợt này đang XANH SAI.** Lượt "dùng literal thay vì hằng" lần đầu cho XANH:
phép đếm `uses >= 2` của bộ đọc hằng bị **chú thích làm phồng** (JSDoc có nhắc tên hằng ⇒ đếm 3, bỏ một chỗ dùng
vẫn còn 2). Đã sửa: bỏ khối chú thích TRƯỚC khi đếm. Đây đúng là thứ R11 tồn tại để tìm — một cổng mới, xanh, mà
không canh được điều nó nói.

**Chệch plan (R5):**

- **62d-11 thêm một ô ở `ci-workflow.test.ts`** mà bản plan chỉ nhắc thoáng: bước publish npm không được chứa chuỗi
  `@udp/`, và chắn `npm view` phải đọc `publishConfig.name`. Không có ô này thì việc chép cứng tên cũ trở lại không
  ai bắt — mà đó là một lỗi chỉ lộ ra ở lượt chạy lại một tag thật.
- **Hai wire fixture được sửa bằng tay** thay vì ghi lại bằng `UDP_CAPTURE_WIRE=1`: thứ đổi là đúng một chuỗi
  specifier bên trong nội dung tệp đề xuất, và ghi lại cả bộ sẽ viết đè nhiều trường biến động không liên quan.
  Đã kiểm lại bằng `wire-golden.test.ts`: **124 ô** vẫn xanh.
- **README của gói đổi `pnpm --filter` sang `pnpm -C packages/openfeature-provider`** ở mục Development. Lý do: hợp
  đồng artifact cấm **mọi** chuỗi `@udp/` trong byte khách nhận, và `pnpm --filter @udp/…` là một ngoại lệ đúng
  nhưng nó buộc cổng phải mang một danh sách miễn trừ. Dạng `-C` chạy y hệt, nên luật giữ được là **tuyệt đối** —
  một cổng không có ngoại lệ là một cổng không ai phải nhớ ngoại lệ.

## Ba vòng QA đã sửa gì (R2)

Ba agent chạy song song trên bản nháp của spec và plan; mỗi cáo buộc quyết định đã được tự kiểm lại trên mã và trên
lệnh thật trước khi nhận. Những chỗ plan bị bẻ:

1. **Ô test tarball sẽ đỏ, và plan gắn lan toả vào sai mục.** `package.test.ts:103` đòi mọi entry là
   `package/package.json` hay dưới `package/dist/`; thêm `LICENSE` + `README.md` là đỏ. Bản nháp treo điều kiện vào
   "nếu nó khẳng định trường nào của **manifest**" — mà cái vỡ là khẳng định về **danh sách tệp**. ⇒ 62a-5.
2. **Node 22 không bao giờ có npm ≥ 11.5.1.** Đo: `npm đóng kèm node v22.20.0 => 10.9.3`, và bản mới nhất của dòng
   22 kèm 10.9.9. Bản nháp viết "Node 22 + npm `>=11.5.1`" như thể có sẵn. ⇒ QĐ-4.
3. **`pnpm pack` KHÔNG xoá `@udp/*`** — nó đổi `workspace:*` thành `0.1.0`, nên manifest phát hành trỏ tới 6 gói
   không tồn tại. Đây là một dữ kiện bản nháp **nói sai**, và nó bị bác bằng phép đo. Vá bằng
   `publishConfig.devDependencies: {}` cũng **không chạy** — pnpm 9.12.0 chỉ nâng một tập khoá biết trước (đo trên
   probe riêng). ⇒ bước dẫn xuất của QĐ-3 và 62a-5.
4. **`actionlint` không tồn tại trong repo** (grep ra đúng hai tệp, cả hai là plan #62) và nó không kiểm được AC-3
   lẫn AC-4; repo đã có cổng cấu trúc workflow với đúng mệnh đề "không `secrets.`"
   (`ci-workflow.test.ts:122`). ⇒ 62b-4.
5. **Job `gate` của bản nháp không chạy nổi hai bộ test nó khai** (cần năm chuỗi role ⇒ phá AC-3), và ô chéo ngôn
   ngữ `python-parity.test.ts` **bỏ qua im lặng** khi thiếu `.venv`. ⇒ `gate` khẳng định `ci.yml` đã xanh trên commit
   được tag.
6. **Hai ô của bản nháp nhân bản cổng đã có, và cổng đang có mạnh hơn** (`package.test.ts:125-126` đọc manifest **đã
   pack**). ⇒ QĐ-11.
7. **`workflow_dispatch` của bản nháp SẼ publish thật** — mô tả "chạy thử tới trước bước publish" không có cơ chế
   nào. Và `--dry-run` **không** diễn tập provenance, cũng **không** bắt `private`. ⇒ hai tệp workflow, QĐ-6.
8. **So khoảng là fail-open:** `>=0.1,<1` chứa `0.2.0` còn `^0.1.0` thì không. ⇒ so chuỗi tính ra, QĐ-9.
9. **`environment:` tự nó không là chốt duyệt**, và **publish nửa vời** (npm lên, PyPI chưa) là trạng thái có thật
   mà bản nháp không nói gì. ⇒ tuần tự, hai đường chạy lại được, luật bump `0.1.1`. Và npm **mặc định chỉ cho
   `npm stage publish`** với cấu hình tạo từ 03/09/2026. ⇒ QĐ-5, QĐ-6, 62c-2.
10. **AC-2 không có cổng nào**: probe xoá tệp `LICENSE` mà vẫn khai `license` ⇒ build exit 0, `twine check` PASSED,
    wheel không mang giấy phép. Và `twine check` **không --strict** exit 0 dù thiếu `long_description`. ⇒ 62b-5,
    62b-6.
11. **`license-files` của PEP 639 là dòng vô tác dụng** — glob mặc định của setuptools đã phủ (đo với/không có
    dòng đó: METADATA giống từng dòng). Giữ nó là một tiêu chuẩn kép với chính lập luận QĐ-1 về `files`. ⇒ bỏ.
12. **`sdks/python` không là thành viên pnpm workspace**, nên ô "đúng hai package không `private`" là điều không thể
    đạt; và bộ đọc hiện tại **không quét `deploy`**. ⇒ 62b-2.
13. **`pnpm --filter … pack` không chạy** (`Unknown option: 'recursive'`), **`pnpm --filter X test typecheck` chỉ
    chạy `test`**, và **`pnpm pack` thành công khi `dist/` thiếu**. ⇒ `pnpm -C`, hai lệnh cổng rời, bước (5) của
    `scripts/pack.ts`.

**Một cáo buộc không nhận:** đổi `packages/golden-path/tests/scan.test.ts:123`
(`"@udp/openfeature-provider": "^0.1.0"`) vì "chép cứng không cổng nào canh". Đó là fixture của manifest **của
khách**, và bộ quét khớp theo **tên gói** (`scan.ts:358`), không đọc version — một khách ghim `^0.1.0` là dữ liệu
hợp lệ, và đổi nó sang `PROVIDER_RELEASE` sẽ ngụ ý sai rằng bộ quét quan tâm version.

**Một đề xuất nhận một nửa:** khẳng định tarball bằng **đúng tập 11 entry** (mạnh hơn allowlist). Không được:
`dist/chunk-SRD43SET.js` mang hash nội dung trong tên nên tập chính xác sẽ đỏ ở mọi lần đổi mã. Lấy phương án lùi:
allowlist ba tệp gốc + tiền tố `dist/`, cộng hai khẳng định dương.

---

## Đã làm — và bằng chứng (R9)

Ba đợt xong trong ngày 03–04/10/2026, ba commit (chỉ ở máy). Không migration.

### Artifact npm — hợp đồng do chính đường đóng gói cưỡng chế

```
$ pnpm -C packages/openfeature-provider exec tsx scripts/pack.ts --out <dir>
…\packout\udp-openfeature-provider-0.1.0.tgz

$ tar -tzf …tgz | sort
package/LICENSE
package/README.md
package/dist/THIRD_PARTY_NOTICES
package/dist/chunk-SRD43SET.js
package/dist/index.js
package/dist/metrics.js
package/dist/types/{index,labels,metrics,provider}.d.ts
package/package.json

$ tar -xzOf …tgz package/package.json   (đọc bằng json)
private: None     publishConfig: None     scripts: None     license: Apache-2.0
main: ./dist/index.js     exports: ['.', './metrics']     deps: None     udp devDeps: []

$ npm publish …tgz --dry-run --access public
npm notice total files: 11      unpacked size: 291.3 kB
+ @udp/openfeature-provider@0.1.0
```

### Artifact PyPI — và bốn phép kiểm giấy phép

```
$ python -m build && twine check --strict dist/*
…whl: PASSED        …tar.gz: PASSED        exit=0        (trước đợt này: exit 0 với "PASSED with warnings")

$ unzip -p dist/*.whl '*/METADATA' | grep -E '^License-(Expression|File):'
License-Expression: Apache-2.0
License-File: LICENSE
$ unzip -l dist/*.whl | grep -c 'dist-info/licenses/LICENSE'   → 1
$ tar -tzf dist/*.tar.gz | grep -cE '/LICENSE$'                → 1

$ unzip -p dist/*.whl '*/METADATA' | head -11
Metadata-Version: 2.4
Name: udp-openfeature
Version: 0.1.0
Summary: OpenFeature provider for UDP server keys in Python: in-process evaluation, SSE sync, and per-request ff labels
Author: UDP
License-Expression: Apache-2.0
Project-URL: Homepage, …/Repository, …/Documentation, …/Issues
Keywords: openfeature,openfeature-provider,feature-flags,…
```

Wheel chỉ chứa `udp_openfeature/` + `*.dist-info/` (đã liệt kê: 5 tệp dist-info, không tệp mã nào khác). **sdist
thì CÓ `tests/`** (9 tệp) cùng `PKG-INFO`, `pyproject.toml`, `setup.cfg`, `README.md`, `LICENSE` — đó là nội dung
mặc định của sdist setuptools và nó bình thường (một người đóng gói lại chạy được bộ test). AC-1 chỉ nói về **wheel**
đúng vì vậy.

Biến ẩn của hai phép đo PEP 639, ghi lại theo yêu cầu của 62c-3: `python 3.13.6` (máy dev) / `3.11` (CI, bản sàn),
`pip 25.2`, `build 1.6.1`, `twine 7.0.0`, `ruff 0.16.9`.

### Cổng

```
$ pnpm --filter @udp/design-lint test            →  31 tệp, 198 ô xanh   (trước: 193)
$ pnpm --filter @udp/deploy test                 →   8 tệp,  76 ô xanh   (trước:  65)
$ pnpm --filter @udp/golden-path test            →   4 tệp,  24 ô xanh
$ pnpm --filter @udp/openfeature-provider test     →   9 tệp, 89 ô xanh (gồm `python-parity` 2 ô chạy THẬT, 40 s — không bị bỏ qua)
$ sdks/python: ruff check / ruff format --check / mypy / pytest  →  sạch, 35 tệp, 34 tệp, 906 ô xanh
$ pnpm --filter @udp/portal exec vitest run       →  41 tệp, 365 ô xanh (cổng thứ bảy: sổ nợ thêm mục không làm `evidence.test.tsx` đỏ)
$ prettier --check  →  sạch;  eslint trên mọi tệp đã đổi  →  sạch
$ pnpm --filter @udp/design-lint sdk-version     →  0.1.0
$ … sdk-version --expect 0.2.0                   →  "version của tag là 0.2.0 nhưng hai manifest ở 0.1.0", exit 1
```

### Kiểm thoái cấp (R11) — mỗi ô mới ĐỎ khi cố tình làm lệch

Mười một lượt làm lệch, mỗi lượt hoàn nguyên ngay. Output thật:

```
thêm lại private                   -> ĐỎ   expected [] to deeply equal [ '@udp/openfeature-provider' ]
nới files sang LICENSE             -> ĐỎ   expected [ 'dist', 'LICENSE' ] to deeply equal [ 'dist' ]
python lệch version 0.2.0          -> ĐỎ   expected '0.1.0' to be '0.2.0'
PROVIDER_RELEASE ^0.2.0            -> ĐỎ   expected '^0.2.0' to be '^0.1.0'
bỏ --provenance                    -> ĐỎ   expected 'version=$(node -p …' to contain '--provenance'
ghim npm@latest                    -> ĐỎ   expected 'npm install -g npm@latest …' to match /^npm install -g npm@\d+\.\d+\.\d+\b/
thêm workflow_dispatch vào publish -> ĐỎ   expected { workflow_dispatch: null, …(1) } to deeply equal { push: { tags: [ 'sdk-v*' ] } }
action PyPI ghim tag thay vì SHA   -> ĐỎ   pypa/gh-action-pypi-publish@release/v1: expected … to match /@[0-9a-f]{40}$/
bỏ permissions của một job         -> ĐỎ   job build-npm phải khai permissions: expected undefined to be defined
thêm ./testing vào publishConfig   -> ĐỎ   artifact phát hành không đạt hợp đồng:
                                            - `exports` phải đúng ., ./metrics, đang là ., ./metrics, ./testing
xoá LICENSE của gói Python         -> build exit 0, twine --strict exit 0, License-Expression exit 0,
                                      nhưng License-File / wheel LICENSE / sdist LICENSE  ->  exit 1, 1, 1
```

Hai chiều của cổng `THIRD_PARTY_NOTICES`:

```
INLINED = ["murmurhash3js"]                        -> ĐỎ  "vào bundle mà KHÔNG được khai: zod"
INLINED = ["zod","murmurhash3js","dotenv"]         -> ĐỎ  "khai mà KHÔNG vào bundle: dotenv"
```

Ba điều đáng ghi về các lượt này:

1. **Lượt `./testing` đỏ ở chỗ TỐT HƠN chỗ dự kiến.** Plan nói ô `package.test.ts:126` sẽ bắt; thực tế hợp đồng
   trong `scripts/pack.ts` ném **trước**, ở `beforeAll`. Nghĩa là một lượt publish bị chặn ở bước đóng gói, không
   chỉ bị báo ở bước test — đúng tính chất "hỏng ồn trước khi gói rời khỏi máy".
2. **Lượt xoá `LICENSE` là lượt duy nhất mà mọi cổng SẴN CÓ đều xanh.** `python -m build` exit 0, `twine check
--strict` PASSED, METADATA vẫn tuyên bố Apache-2.0. Không có bốn phép kiểm của 62b-5 thì AC-2 là một lời hứa.
3. **Một lần tôi tự đánh mất mã bằng `git checkout --`.** Sau khi chứng minh hai chiều của cổng notices, tôi hoàn
   nguyên `build.ts` bằng `git checkout -- <tệp>` — nhưng chính cổng đó **chưa commit**, nên lệnh đó xoá luôn nó.
   Phát hiện ngay bằng `grep -c metafile` (ra `0`) và phục hồi từ một bản `cp` làm trước đó. Đúng hình dạng sự cố
   `git reset --hard` của Plan #61. **Luật cho người sau: commit cổng TRƯỚC khi cố tình làm lệch, và hoàn nguyên
   bằng bản sao ngoài repo, không bằng `git checkout`.** Ba đợt sau đó đều commit trước khi làm lệch.

### Chệch plan (R5)

- **62b-3 sinh thêm một tệp mã**, `packages/design-lint/src/toml-version.ts`, và một script
  `packages/design-lint/scripts/sdk-version.ts`. Plan nói "một bước `node -p` đọc hai tệp, không script mới" — nhưng
  đọc `[project].version` fail-closed là ~30 dòng, và viết lại nó trong một `.mjs` của workflow là nguồn sự thật thứ
  hai cho cùng một phép đọc (R8). Script dùng chung giữ một bản.
- **62b-1 thành NĂM job thay vì bốn**, vì build tách khỏi publish: quyền publish không nên sống cùng job đã chạy
  `pnpm install` và lifecycle script của cả cây phụ thuộc. `upload-artifact` đã là tiền lệ trong `ci.yml`.
- **Tên tệp workflow là `publish.yml`** (không `publish-sdk.yml` như bản nháp): quy ước của repo là một từ, và tên
  này là **cấu hình của registry** nên đổi về sau sẽ phá cả hai trusted publisher.
- **`sdks/python/README.md` được sửa thêm một chỗ ngoài phạm vi**: comment căn lề trong một khối Python làm
  `ruff format --check` đỏ — và nó **đã đỏ từ trước đợt này** (chứng minh trên commit `dca2fdc`). Sửa vì cổng đó
  nằm trong job CI `python` mà 62a-3 đang chạm.
