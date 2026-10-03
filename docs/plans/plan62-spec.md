# Plan #62 — Phát hành hai SDK: npm và PyPI

> **Nối tiếp (R3):** Plan #26 và #47 (`@udp/openfeature-provider` và `udp-openfeature` — hiện thực xong, kiểm tương
> đương xong), Plan #48 (Golden Path sinh mã của khách), Plan #61 (ghim theo digest, chữ ký, trusted deploy bằng
> OIDC). Giữ nguyên mọi quyết định của chúng: `dependencies` của gói Node RỖNG, `@udp/*` ở `devDependencies`,
> subpath `./testing` CHỈ trong monorepo, `publishConfig` là nguồn sự thật của manifest phát hành, peer để ngoài
> bundle, `files: ["dist"]`.
>
> **Mục thiết kế (R4):** §6.8 "`@udp/openfeature-provider` — package chạy trong ứng dụng của khách" — mục con
> "Đóng gói, phụ thuộc, và cách kiểm" (gạch cuối của nó ghi đúng việc của đợt này: _"**Chưa làm (lộ trình):** phát
> hành npm (gói còn `private`) và PyPI (gói Python chưa phát hành)"_), mục con "Bản Python"; §11 (Golden Path);
> §13.5 (CI của chính UDP); §16 hai dòng "Provider Python" và "Provider chưa phát hành npm".

## 0. Vì sao đợt này, và vì sao nó không phải việc trang trí

Golden Path **đã** sinh ra manifest trỏ tới hai gói **không tồn tại**:

```
packages/golden-path/src/render.ts:42   export const PROVIDER_RELEASE = "^0.1.0";
packages/golden-path/src/render.ts:82     .replaceAll('"workspace:*"', `"${PROVIDER_RELEASE}"`);
packages/golden-path/templates/python/requirements.txt:6   udp-openfeature[metrics]>=0.1,<1
```

```
$ npm view @udp/openfeature-provider version
npm error 404 Not Found - GET https://registry.npmjs.org/@udp%2fopenfeature-provider - Not found

$ npm view udp-openfeature version
npm error 404 Not Found - GET https://registry.npmjs.org/udp-openfeature - Not found

$ curl -s -o /dev/null -w "%{http_code}" https://pypi.org/pypi/udp-openfeature/json
404
```

Nghĩa là **hôm nay** một người dùng UDP bấm qua Golden Path, tải cây mã về và chạy `npm install` hay
`pip install -r requirements.txt` thì nhận 404. Đây không phải một món "nice to have" của lộ trình: đây là một
đường đi của sản phẩm đang đứt, trong khi §6.8 nói "Golden Path phủ Node.js và Python" như thể nó liền.

> Chính xác hơn, và đây là một chỗ tài liệu **tự trích sai** cần sửa ở 62c-1: câu đó nằm ở §6.8 (`:4661`) và nó
> viện dẫn §16, nhưng §16 (`:8620`) viết _"Golden Path (mẫu dự án + hook telemetry) **chỉ** Node.js và Python"_ —
> một giới hạn, gần như nghĩa ngược.

Đợt này nối lại đường đó, và nối bằng cách mà Plan #61 đã chọn cho mọi đường phát hành khác của UDP: **OIDC thay
cho token dài hạn**, có provenance.

Và đo luôn hai artifact ở trạng thái HÔM NAY, để biết chính xác còn thiếu gì:

```
$ cd packages/openfeature-provider && ls LICENSE README.md
ls: cannot access 'LICENSE': No such file or directory
ls: cannot access 'README.md': No such file or directory

$ cd sdks/python && python -m build && twine check dist/*
Successfully built udp_openfeature-0.1.0.tar.gz and udp_openfeature-0.1.0-py3-none-any.whl
…whl: PASSED with warnings
WARNING  `long_description_content_type` missing. defaulting to `text/x-rst`.
WARNING  `long_description` missing.

$ unzip -p udp_openfeature-0.1.0-py3-none-any.whl '*/METADATA' | head -5
Metadata-Version: 2.4
Name: udp-openfeature
Version: 0.1.0
Summary: OpenFeature provider của UDP cho Python — đánh giá tại chỗ, stream SSE, nhãn ff (§6.8)
Requires-Python: >=3.11
```

Gói Python **build được ngay** và metadata hợp lệ (2.4) — nhưng không giấy phép, không mô tả dài, không URL, không
classifier, và `Summary` là tiếng Việt có ký hiệu `§` của tài liệu nội bộ. Gói Node thì chưa có cả `LICENSE` lẫn
`README.md`. Đó là danh sách việc của AC-1, AC-2 và AC-5, không phải suy đoán.

## 1. Mục tiêu và tiêu chí đạt

| AC   | Tiêu chí                                                                                                                                                                                                                                     |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| AC-1 | Hai gói phát hành được, artifact ĐÚNG hợp đồng: tarball npm chỉ `package.json` + `LICENSE` + `README.md` + `dist/**`, manifest không nhắc `@udp/*` và không mang `scripts`; wheel không có mã nào ngoài `udp_openfeature/`                   |
| AC-2 | Thứ được phát hành có giấy phép tường minh, giấy phép đó **nằm trong** artifact, và mọi thư viện bên thứ ba góp vào bundle vừa tương thích vừa **được liệt kê** — cả ba do máy cưỡng chế, không do một lượt suy luận tay                     |
| AC-3 | Đường phát hành không có token dài hạn: npm qua trusted publishing (OIDC) kèm provenance, PyPI qua trusted publisher kèm attestation PEP 740. Hai job phát hành chỉ có `id-token: write`; tệp workflow không nhắc `secrets.` — kiểm bằng máy |
| AC-4 | Phát hành chỉ xảy ra từ một tag `sdk-v*`, sau khi `ci.yml` đã xanh trên đúng commit đó, và version của tag bằng version của **cả hai** manifest. Không có đường nào để một lượt chạy tay phát hành thật                                      |
| AC-5 | Trang gói trên npm và PyPI đọc được một mình: cài gì, dùng thế nào, tuỳ chọn, giới hạn đã biết (không có fail-closed), giấy phép, đường về tài liệu                                                                                          |
| AC-6 | Có cổng giữ `PROVIDER_RELEASE` và `requirements.txt` của Golden Path khớp version của hai manifest. Việc "Golden Path hết trỏ tới gói không tồn tại" chỉ xảy ra sau lượt publish thật ⇒ nó là tiêu chí **Đạt** của mục nợ `sdk-publish-real` |
| AC-7 | Cổng chống thoái cấp: **đúng một** package workspace không `private` và nó là gói SDK Node; `files` vẫn đúng `["dist"]`; artifact phát hành không có `./testing`, không có `@udp/*`; `dependencies` vẫn rỗng                                 |
| AC-8 | Mọi bước máy không làm được (chiếm tên ở hai registry, một lượt publish bootstrap npm, đăng ký hai trusted publisher kèm **Allowed actions**, bật Required reviewers cho hai environment) có một mục nợ với lệnh và cách kiểm từng bước      |

## 2. Quyết định

### QĐ-1 — Giấy phép: Apache-2.0, đặt TRÊN HAI GÓI, không trên cả repo

`packages/openfeature-provider/LICENSE` và `sdks/python/LICENSE` — **nguyên văn tải từ nguồn gốc**, không gõ lại:

```
$ curl -fsSL https://www.apache.org/licenses/LICENSE-2.0.txt -o LICENSE && wc -l LICENSE && sha256sum LICENSE
202 LICENSE
cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30  LICENSE
```

- **Vì sao Apache-2.0 chứ không MIT:** gói này chạy TRONG tiến trình của ứng dụng khách và nằm trong hệ sinh thái
  OpenFeature — `@openfeature/server-sdk` và `openfeature-sdk` đều Apache-2.0 (CNCF). Apache-2.0 có điều khoản bằng
  sáng chế tường minh (Apache-2.0 §3 "Grant of Patent License" — mục của GIẤY PHÉP, không phải §3 của
  `UDP_design.md`) mà MIT không có; với một thư viện người ta nhúng vào đường đi chính của ứng dụng, đó là thứ bên
  pháp lý của người tích hợp sẽ hỏi.
- **Vì sao KHÔNG đặt `LICENSE` ở gốc repo:** giấy phép là tuyên bố về thứ được PHÁT HÀNH. Đợt này phát hành đúng hai
  gói SDK; Service 1/2/3, Portal và 18 package workspace còn lại không được phát hành ở đâu cả. Đặt một `LICENSE` ở
  gốc là tuyên bố mở nguồn toàn bộ nền tảng — một quyết định về tài sản của khoá luận, không phải một bước kỹ thuật
  của việc phát hành SDK. Phần còn lại của repo giữ nguyên trạng. Mở rộng về sau là một dòng thêm vào.
- **Không khai `files: ["dist", "LICENSE"]` và không khai `license-files` của PEP 639** — cả hai là dòng vô tác
  dụng, đo trước khi viết (R7). npm/pnpm luôn đưa `LICENSE` và `README.md` vào tarball bất kể `files`:

  ```
  $ printf 'TEMP\n' > LICENSE && printf '# temp\n' > README.md && pnpm pack && tar -tzf …tgz | sort
  package/LICENSE
  package/README.md
  package/dist/THIRD_PARTY_NOTICES
  package/dist/chunk-SRD43SET.js
  package/dist/index.js
  package/dist/metrics.js
  package/dist/types/{index,labels,metrics,provider}.d.ts
  package/package.json
  ```

  Và glob mặc định của setuptools (`LICEN[CS]E*`, `COPYING*`, `NOTICE*`, `AUTHORS*`) đã nhặt `LICENSE` vào
  `*.dist-info/licenses/` mà không cần khai `license-files` — đo trên Python 3.11 thật với và không có dòng đó:
  METADATA giống nhau từng dòng (`License-File: LICENSE`, `Dynamic: license-file`).

  Thêm một dòng không có tác dụng thì tệ hơn là không thêm: nó dạy người đọc rằng `files` (hay `license-files`) là
  danh sách đầy đủ, nên lần sau ai đó thêm một tệp vào đó "cho chắc" mà không biết mình đang mở rộng artifact thật.
  Và **`NOTICE` thì KHÔNG tự vào tarball npm** (npm và pnpm cùng chỉ tự thêm `LICENSE*`/`LICENCE*`/`COPYING`/
  `README*`) — nên nếu một ngày cần `NOTICE`, nó phải được khai tường minh. Đó là lý do cổng AC-1 khẳng định **tập**
  tệp gốc chứ không chỉ khẳng định "có LICENSE".

- **Mã góp vào bundle:** đo bằng `metafile` của esbuild, không bằng niềm tin — bundle hôm nay chứa đúng `zod` (MIT)
  và `murmurhash3js` (MIT), và `dist/THIRD_PARTY_NOTICES` có đúng hai khối cho hai gói đó. MIT phát hành lại được
  dưới Apache-2.0. Nhưng danh sách trong `scripts/build.ts` là **viết cứng**
  (`const INLINED = ["zod", "murmurhash3js"]`), nên AC-2 đòi một cổng: xem 62b-6.

### QĐ-2 — Hai gói đi cùng một số version, và có cổng giữ

`0.1.0` cho cả hai; một cổng đòi `version` của `packages/openfeature-provider/package.json` **bằng** `version` của
`sdks/python/pyproject.toml`.

- **Vì sao lockstep:** §6.8 "Bản Python" nói hai bản có **cùng** máy trạng thái, cùng tuỳ chọn, cùng giá trị mặc
  định, và tương đương được kiểm bằng **cùng một** tệp vector (`packages/flag-evaluator/conformance/vectors.json`).
  §6.8 dựa vào đó để nói "Golden Path phủ Node.js và Python" mà không kèm chú thích về khác biệt hành vi. Hai số
  version rời nhau cho hai bản được kiểm tương đương bằng cùng một tệp là mời người đọc đoán xem `0.2.1` của Python
  tương đương bản Node nào.
- **Vì sao đúng `0.1.0`:** Golden Path đã ghim `^0.1.0` và `>=0.1,<1`. Số này không phải chọn tự do — nó là số mà
  mã đã phát hành của UDP đang chờ.
- **Đây KHÔNG phải một bất biến mới của §13.3, và nói rõ vì sao.** §13.3 là nơi của tính chất của **hệ đang chạy**
  (I26 hai đường đánh giá cho cùng kết quả, I33 không ném ra ứng dụng khách, I34 fail-static). I28 và I35 là tiền lệ
  cho "bất biến cưỡng chế bằng design-lint", nhưng chúng nói về **kiến trúc** (adapter không chạm ra ngoài thư mục
  của nó, ma trận người ghi). "Hai gói cùng số version" là một luật của **quy trình phát hành**. Đưa nó vào §13.3 là
  biến §13.3 thành nơi chứa cả chính sách release, và kéo theo phải bump `Tổng cuối: **44 bất biến**`
  (`UDP_design.md:8790`, có cổng `references.test.ts` đếm). Chọn: **không** đăng ký, gọi đúng tên nó là một ô ranh
  giới gói, và ghi câu này ra để người sau không phải đoán.
- **Lockstep chỉ cưỡng chế được TRONG kho.** Sau khi phát hành, người tiêu thụ cài hai gói rời nhau từ hai khoảng
  (`^0.1.0` và `>=0.1,<1`), nên có thể trộn hai version lệch. §16 nhận thêm một dòng nói đúng điều đó: I26 chéo
  ngôn ngữ chỉ bảo đảm cho **cặp cùng số version**.

### QĐ-3 — npm: `pnpm pack` dựng manifest, một bước DẪN XUẤT, rồi `npm publish <tarball>` bằng OIDC

Đường phát hành nằm trong **một** script — `packages/openfeature-provider/scripts/pack.ts` — và đúng script đó được
dùng bởi **cả** bộ test tiêu thụ **và** workflow phát hành, nên thứ được kiểm đúng là thứ được phát hành:

1. `tsx scripts/build.ts` (esbuild + tsc).
2. `pnpm pack` ở thư mục package → tarball.
3. Giải nén, **xoá** mọi khoá `@udp/*` khỏi `devDependencies` và **xoá** `scripts`.
4. `npm pack` thư mục đó → **artifact phát hành**.
5. Khẳng định hợp đồng artifact (AC-1, AC-7) và **ném** nếu lệch.

Rồi `npm publish <tarball> --access public --provenance`.

**Vì sao từng bước — đo thật, không tin trí nhớ (R7).**

**(a) `npm pack` không áp `publishConfig`.** Manifest trong tarball do `npm pack` sinh:

```
  "private": true,
  "main": "./src/index.ts",            ← trỏ vào src, mà src KHÔNG có trong tarball
  "exports": { ".": "./src/index.ts", "./metrics": "./src/metrics.ts", "./testing": "./src/testing.ts" },
  "publishConfig": { … }               ← còn nguyên, chưa áp
```

**(b) `pnpm pack` thì áp, nhưng nó KHÔNG xoá `@udp/*` — nó đổi `workspace:*` thành version cục bộ.** Đây là chỗ bản
nháp đầu của spec này **nói sai**, và phép đo bác lại:

```
$ tar -xzOf …tgz package/package.json | python -c "import sys,json;print(json.load(sys.stdin)['devDependencies'])"
{… "vitest": "^2.1.8",
 "@udp/config": "0.1.0", "@udp/flag-evaluator": "0.1.0", "@udp/metrics-provider": "0.1.0",
 "@udp/db": "0.1.0", "@udp/test-support": "0.1.0", "@udp/shared-types": "0.1.0"}
private: True      publishConfig: None      scripts: ['build','test','test:watch','typecheck']
```

Sáu gói đó **không tồn tại trên npm**. Khách không cài `devDependencies` của một dependency, nên `npm install` không
404 — nhưng mọi công cụ SBOM/SCA/mirror đi theo devDeps thì 404, và nó nói sai về chính gói. `scripts` thì bảo người
đọc chạy `tsx scripts/build.ts`, một tệp không có trong tarball.

**(c) `publishConfig.devDependencies` KHÔNG vá được — pnpm 9.12.0 bỏ qua.** Đo trên một probe riêng:

```
$ cat package.json   # publishConfig: { main, devDependencies: {}, scripts: {} }
$ pnpm pack && tar -xzOf out/*.tgz package/package.json
  "publishConfig": { "devDependencies": {}, "scripts": {} },   ← còn nguyên, KHÔNG được áp
  "devDependencies": { "typescript": "^5.6.3" },               ← giữ y cũ
  "scripts": { "build": "echo hi" },
  "main": "./dist/i.js"                                        ← chỉ khoá này được nâng
```

pnpm chỉ nâng một tập khoá biết trước (`main`, `types`, `exports`, `bin`…). Nên bước xoá phải là một bước **của ta**.

**(d) Bước dẫn xuất KHÔNG phải nguồn sự thật thứ hai (R8).** `publishConfig` vẫn là nơi duy nhất khai hình dạng
manifest phát hành; bước (3) là một phép **xoá theo luật đã khai** (`@udp/*` và `scripts`), chạy trong một script, và
kết quả được khẳng định ở bước (5). Một bản manifest viết tay thứ hai thì mới là nguồn thứ hai.

**(e) Vì sao `npm publish <tarball>` chứ không `npm publish <thư mục>`.** Đường thư mục chạy lifecycle script
(`prepublishOnly`, `publish`, `postpublish`); đường tarball thì không. Và `--provenance` làm việc như nhau: npm tính
subject từ bytes của tarball, không từ dạng đối số. Dry-run thật trên tarball: `total files: 11`,
`+ @udp/openfeature-provider@0.1.0`.

**(f) Lệnh pack phải là `pnpm -C <dir> pack`, KHÔNG `pnpm --filter … pack`:**

```
$ pnpm --filter @udp/openfeature-provider pack --pack-destination …
 ERROR  Unknown option: 'recursive'
$ pnpm -C packages/openfeature-provider pack --pack-destination …
…\udp-openfeature-provider-0.1.0.tgz
```

**(g) `pnpm pack` thành công khi `dist/` thiếu**, và `npm publish --dry-run` nhận luôn một tarball ba tệp không có
`dist/` nào trong khi `main` trỏ `./dist/index.js`. Nên bước (5) là bắt buộc, và nó phải nằm trong chính script
pack: nó là thứ **chặn** một lượt publish, không phải thứ báo cáo sau.

**(h) `npm publish --dry-run` KHÔNG bắt `private: true`:**

```
$ npm publish --dry-run --access public      # manifest có "private": true
+ udp-priv-probe-xyz@0.0.1     --- exit=0 ---
```

Phép kiểm `private` của npm nằm sau nhánh `if (!dryRun)`. Nên mọi cổng về hình dạng manifest phải đọc **manifest đã
đóng gói**, không dựa vào dry-run. Và vì thế bỏ `private` ở manifest nguồn là việc của 62a-2, chứ không phải việc
của bước dẫn xuất: một manifest nói mình private trong khi gói đang ở trên npm là metadata nói dối. Rủi ro "publish
nhầm tại máy" được chặn bởi thứ khác và chặn chặt hơn — trusted publishing ràng quyền publish vào **một tên tệp
workflow**, nên một lượt `npm publish` ở máy không có cách nào xác thực.

- **Vì sao không nâng pnpm:** `packageManager` ghim `pnpm@9.12.0` cho 21 package của workspace. Nâng package manager
  của cả monorepo để lấy một tính năng của đúng một đường phát hành là đổi thứ mà mọi thứ khác đang đứng trên.

### QĐ-4 — npm CLI phải ≥ 11.5.1, và `actions/setup-node` KHÔNG bao giờ cho bản đó trên Node 22

```
$ node -e "…đọc <nodedir>/node_modules/npm/package.json…"
npm đóng kèm node v22.20.0 => 10.9.3
```

Dòng Node 22 không có bản nào kèm npm 11.x (bản mới nhất của dòng, v22.23.3, kèm npm 10.9.9). Trusted publishing
đòi **npm ≥ 11.5.1**. Nên job phát hành ghim npm tường minh:

```yaml
- run: npm install -g npm@11.21.0 --ignore-scripts # OIDC cần ≥ 11.5.1; Node 22 chỉ kèm 10.9.x
- run: npm --version
```

- **`11.21.0` chứ không `latest`:** `@latest` là một tarball không ghim, tải vào đúng job đang cầm quyền publish —
  trái chính kỷ luật ghim của `build-toolchain.ts`. `11.21.0` là bản cuối của dòng 11 (bản mới nhất của npm hôm nay
  là `12.2.0`; không nhảy major trong một đường không thu hồi được).
- **Vẫn giữ `node-version: 22`** để khớp `engines.node >= 22.22.2` của gốc repo và khớp mọi job khác.
- Dòng này đi ngược quy ước `ci.yml` ("không ghim version ở workflow, `packageManager` là nguồn duy nhất") nên nó
  phải có chú thích nói vì sao: `packageManager` ghim **pnpm**, còn npm 10.9.x là bản Node đóng kèm mà không nguồn
  nào trong repo khai.
- **Không truyền `registry-url` cho `setup-node`.** Nó ghi một `.npmrc` cấp user với `NODE_AUTH_TOKEN` giả
  (`XXXXX-XXXXX-XXXXX-XXXXX`), làm npm tin là "đã có credential" và biến một lỗi OIDC thành một 401 bí ẩn — vì hàm
  OIDC của npm cố ý **không bao giờ ném**, mọi nhánh lỗi là `return undefined`.

### QĐ-5 — PyPI đi được hết bằng máy; npm thì không, và chỗ đó là một mục nợ

|                                                       | npm                                                                                               | PyPI                                                                 |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| Đăng ký trusted publisher cho gói **chưa tồn tại**    | **Không** — gói phải có trước                                                                     | **Có** — "pending publisher", PyPI tạo project ở lượt publish đầu    |
| Giữ chỗ tên khi đã khai publisher                     | —                                                                                                 | **Không**: pending publisher bị vô hiệu nếu người khác lấy tên trước |
| Mặc định **Allowed actions** (cấu hình từ 03/09/2026) | chỉ `npm stage publish`; muốn `npm publish` thì phải **tích thêm**                                | không có khái niệm này                                               |
| Hệ quả                                                | Một lượt `npm publish` **bằng tay** để chiếm tên, rồi đăng ký publisher **và tích `npm publish`** | Khai pending publisher rồi phát hành ngay, không bước tay nào        |

Bất đối xứng này là của hai registry, không phải chỗ hở của plan. Mọi việc máy không làm được vào mục nợ
`sdk-publish-real` (AC-8), vì nó đòi tài khoản của chủ repo. **Rủi ro tên áp cho CẢ HAI registry** — bốn phép kiểm
(`npm view`, `registry.npmjs.org/@udp%2f…`, `/-/org/udp`, `search?text=scope:udp` trả `total: 0`) nói `@udp` chưa có
gói nào, và cả bốn dạng chuẩn hoá PEP 503 của `udp-openfeature` trả 404; nhưng không phép nào kết luận chắc được vì
endpoint tổ chức đòi đăng nhập. **[04/10/2026] Rủi ro này ĐÃ XẢY RA, và cách giải khác với dự phòng viết ở trên.** npm trả `The organization name 'udp' is not available`: đã có package `udp@1.0.0`, và org với package dùng chung một không gian tên — scope `@udp` **không bao giờ** lấy được. Không đổi scope nội bộ (42 tệp, và `@udp/` là quy ước tám ô ranh giới dựa vào): giữ tên trong kho, khai tên công khai `udp-openfeature` ở `publishConfig.name`, và **ÁP nó ở bước dẫn xuất của `scripts/pack.ts`** — pnpm 9.12.0 (bản repo ghim) **không** nâng khoá đó, một phép đo ban đầu kết luận ngược vì nó chạy ngoài repo nơi `pnpm` là bản toàn cục 11.22.0. Chi tiết ở đợt 62d của `plan62-plan.md`.

Nếu scope đã có chủ: đổi sang scope của chính tài khoản
(`@<github-user>/openfeature-provider`) — một lượt đổi tên ở manifest, các chỗ import trong monorepo,
`PROVIDER_RELEASE`, template Golden Path và §6.8.

### QĐ-6 — Hai tệp workflow, và tệp phát hành KHÔNG có `workflow_dispatch`

- **`.github/workflows/publish.yml`** — `on: push: tags: ["sdk-v*"]`, **không** `workflow_dispatch`.
- **`.github/workflows/publish-rehearsal.yml`** — **chỉ** `workflow_dispatch`, `permissions: { contents: read }`,
  **không** `id-token: write`, **không** `environment`; nó build, pack, và `npm publish --dry-run`.

**Vì sao hai tệp chứ không một `if:`.** Cả npm lẫn PyPI ràng trusted publisher vào **tên tệp workflow** (npm:
"Workflow filename (required)"; PyPI: token OIDC của `foo.yml` không thể đóng vai `bar.yml`). Nên "không có đường
nào để một lượt chạy tay phát hành thật" (AC-4) thành một tính chất **registry bảo đảm**, không phải một `if:` mà ai
cũng sửa được. Lớp thứ hai: thiếu `id-token: write` thì `--provenance` ném `EUSAGE` **trước** mọi PUT.

Và nó cần thiết vì diễn tập bằng dry-run hứa nhiều hơn nó làm: `--dry-run` **không** diễn tập provenance một chút
nào (phần sinh provenance nằm sau nhánh `if (!dryRun)`), và cũng không bắt `private`. Tệp diễn tập vì thế chỉ được
khẳng định đúng thứ nó chứng minh được: version khớp, build chạy, hợp đồng artifact đạt.

> **Tên tệp là cấu hình của registry.** Đổi `publish.yml` về sau sẽ **phá** cả hai trusted publisher (npm: "Existing
> trusted publisher connections cannot be changed"). Tên này vào mục nợ như một giá trị **đã chốt**. Và
> `workflow_dispatch` chỉ xuất hiện khi tệp đã nằm trên nhánh mặc định, nên lượt diễn tập đầu chỉ chạy được sau khi
> merge vào `main`.

Bên trong `publish.yml` — `permissions: { contents: read }` ở **cấp workflow** (sàn; `deploy.yml` và `toolchain.yml`
đều làm thế), rồi nâng ở từng job:

| Job          | `needs`             | Quyền                                 | Việc                                                                                      |
| ------------ | ------------------- | ------------------------------------- | ----------------------------------------------------------------------------------------- |
| `gate`       | —                   | `contents: read`, `actions: read`     | `ci.yml` đã xanh trên `github.sha`; version tag = version hai manifest; cổng đọc tệp      |
| `build-npm`  | `gate`              | `contents: read`                      | `tsx scripts/pack.ts` → artifact                                                          |
| `build-pypi` | `gate`              | `contents: read`                      | `python -m build`, `twine check --strict`, bốn phép kiểm giấy phép → artifact             |
| `npm`        | `build-npm`         | `id-token: write`, env `release-npm`  | ghim npm, so `repository.url`, bỏ qua nếu version đã có, `npm publish <tgz> --provenance` |
| `pypi`       | `npm`, `build-pypi` | `id-token: write`, env `release-pypi` | `pypa/gh-action-pypi-publish` (ghim SHA), `attestations: true`, `skip-existing: true`     |

- **`gate` KHÔNG chạy lại bộ test.** Hai bộ test mà bản nháp định chạy (`@udp/openfeature-provider`,
  `@udp/design-lint`) có ô **cần database thật** (`integration.test.ts`, `python-parity.test.ts`,
  `ledger-row-conformance`, `schema-conformance`, `service-boot-contract`, `writer-matrix`), nên chúng đòi năm chuỗi
  role — phá AC-3. Tệ hơn: `python-parity.test.ts` **bỏ qua im lặng** khi thiếu `sdks/python/.venv`, nên cổng sẽ
  xanh với đúng ô I15c/I26 ở trạng thái _skipped_. Thay vào đó `gate` khẳng định **`ci.yml` đã xanh trên đúng commit
  được tag** — mạnh hơn, vì `ci.yml` chạy cả database, cả `.venv`, cả `portal-demo`, cả `kind`:

  ```bash
  conclusion=$(gh run list --workflow=ci.yml --commit="$GITHUB_SHA" --json conclusion --jq '.[0].conclusion')
  [ "$conclusion" = "success" ] || { echo "ci.yml chưa xanh trên $GITHUB_SHA: '${conclusion:-không có lượt chạy nào}'"; exit 1; }
  ```

  Chuỗi rỗng ⇒ đỏ: một tag trỏ vào commit mà CI chưa chạy thì không phát hành được. Và ba cổng đọc tệp
  (`package-boundaries`, `debt-ledger`, `references`) **không** chạm database — đã kiểm `import` của cả ba.

- **Tuần tự `npm` → `pypi`, không song song.** npm có nhiều cửa từ chối **phía client** hơn PyPI (EPRIVATE,
  prerelease thiếu `--tag`, "cannot publish over", `ensureProvenanceGeneration` thiếu `id-token`) — tất cả nổ trước
  PUT. Cho nó chạy trước nghĩa là khi tới lượt PyPI thì phía khó đã qua, nên xác suất "một gói lên, một gói chưa"
  nhỏ nhất.
- **Và nếu vẫn split:** cả hai phía phải **chạy lại được**. npm: một bước chắn `npm view "<pkg>@$VER"` ⇒ bỏ qua nếu
  đã có (npm từ chối đăng lại một version). PyPI: `skip-existing: true`. Nếu vẫn không chạy lại được thì luật là
  **bump cả hai lên `0.1.1` rồi phát hành lại** — không bao giờ dùng lại một số version đã bị đốt ở một registry.
- **Hai environment, không một.** Một `release` chung thì một lượt duyệt mở cả hai registry. Và cả hai trusted
  publisher đều có trường "Environment name", nên hai environment rời nhau cho hai publisher hai ràng buộc rời nhau:
  job này không dùng được token của job kia.
- **`environment:` TỰ NÓ không là chốt duyệt.** Nó chỉ chặn khi chủ repo bật "Required reviewers" trong Settings →
  Environments; trong YAML không khai được. Nếu environment rỗng thì job chạy ngay. Việc bật nó, và lệnh kiểm
  (`gh api repos/:owner/:repo/environments/release-npm --jq '.protection_rules'` phải thấy `required_reviewers`), là
  một dòng của mục nợ.

### QĐ-7 — `pypa/gh-action-pypi-publish` ghim theo SHA, và đó là action bên thứ ba thứ BA của repo

```
pypa/gh-action-pypi-publish@dc37677b2e1c63e2034f94d8a5b11f265b73ba33  # v1.14.2
```

- Repo hiện có đúng **hai** action ngoài họ `actions/*`: `pnpm/action-setup@v4` và `helm/kind-action@v1`, cả hai ghim
  **tag**. Nhưng cả hai chỉ cài công cụ. Action này chạy **trong job cầm `id-token: write`** và đổi token OIDC thành
  quyền publish PyPI — đúng mục tiêu giá trị cao nhất của sự cố `trivy-action` 03/2026 (75/76 tag bị đẩy đè) mà
  `build-toolchain.ts:4-7` sinh ra để chống, và thứ nó phát hành là không thu hồi được. Nên nó ghim chặt hơn hai cái
  kia: 40 ký tự hex.
- **Vì sao không tự mint token bằng shell** (`$ACTIONS_ID_TOKEN_REQUEST_URL` → `POST /_/oidc/mint-token` →
  `twine upload`), dù lối đó khớp câu "mọi việc khác là lệnh shell": action sinh **attestation PEP 740** (input
  `attestations` mặc định `true`) — tương đương provenance ở phía PyPI, và AC-3 đòi nó. Tự mint token thì mất
  attestation, tức một thoái cấp của artifact phát hành để đổi lấy một dòng YAML.
- `attestations: true` khai **tường minh** dù đã là mặc định, cùng lý lẽ với `--provenance` tường minh: một đòi hỏi
  của AC phải nhìn thấy được trong tệp.

### QĐ-8 — `--provenance` tường minh, và `repository.url` so TRƯỚC khi publish

- `--provenance` không xung đột với trusted publishing (tài liệu npm: provenance tự sinh "without requiring the
  `--provenance` flag"; mã npm chỉ tự bật khi người dùng **không** truyền cờ). Giữ cờ tường minh vì nó biến đòi hỏi
  của AC-3 thành thứ **máy cưỡng chế**: thiếu `id-token: write` ⇒ `EUSAGE` **trước** mọi PUT.
- `repository.url` **không** được client kiểm — mọi dữ liệu predicate SLSA lấy từ biến môi trường GHA. Phép khớp nằm
  ở registry, và tài liệu npm nói nó **case-sensitive**. Hỏng ở đó là hỏng sau khi byte đã rời runner (gói không
  được tạo, nhưng chốt duyệt đã tiêu). Nên job `npm` có một bước so trước:

  ```bash
  node -p "require('./package.json').repository.url" | grep -qx "git+$GITHUB_SERVER_URL/$GITHUB_REPOSITORY.git"
  ```

### QĐ-9 — Cổng mới đọc tệp bằng bộ đọc FAIL-CLOSED, và so CHUỖI TÍNH RA chứ không so khoảng

Repo **không có** thư viện TOML nào (`grep -ic toml pnpm-lock.yaml` → `0`) và Node cũng không. Ba mẫu regex hồn
nhiên đều fail-open — đo trên 8 đầu vào: `/version\s*=\s*"([^"]+)"/` đọc ra `"py311"` khi `[tool.ruff]` được dời lên
trên `[project]` (vì `target-version` chứa chuỗi con `version`); mẫu `^version` bị một dòng comment đánh lừa; mẫu
`\[project\][\s\S]*?version` lấy giá trị của `[tool.poetry]`.

Bộ đọc `projectVersionOf` đi theo bảng, bỏ dòng comment, và **khẳng định lực lượng bằng 1**: 0 hay ≥2 khoá `version`
trong `[project]` đều **ném**, không trả giá trị. Vì sao nó không gặp lỗi "chỉ thấy 42 trong 71" của `chartPinsOf`
(Plan #61): lỗi đó là một phép **đếm thiếu im lặng** trên một tập hợp có lực lượng không biết trước, nên `Map.size`
vẫn là một số dương trông hợp lý. Ở đây lực lượng **bằng 1 theo thiết kế** và bộ đọc khẳng định đúng lực lượng đó,
nên mọi chế độ bỏ sót và mọi chế độ nhập nhằng đều thành ngoại lệ.

Cùng kỷ luật cho `PROVIDER_RELEASE`: đọc `render.ts` bằng chữ (`@udp/design-lint` **không** phụ thuộc
`@udp/golden-path`, và thêm vào sẽ đụng ô "mỗi package khai đúng những `@udp/*` mà nó thật sự import"), và đòi
`matchAll` ra **đúng một** kết quả — để một `PROVIDER_RELEASE_LEGACY` về sau không lọt.

**Và cổng Golden Path so CHUỖI TÍNH RA, không so khoảng.** `^0.1.0` và `>=0.1,<1` **không tương đương**: với hai
manifest ở `0.2.0`, `>=0.1,<1` vẫn chứa `0.2.0` (xanh) còn `^0.1.0` thì không (đỏ). Phép "khoảng có chứa version"
cho phép một khoảng rộng tuỳ ý, nên nó không bảo vệ được tính chất AC-6 muốn. Thay bằng:

```ts
const [maj, min] = version.split(".");
expect(providerRelease).toBe(`^${maj}.${min}.0`);
expect(requirementsLine).toBe(
  `udp-openfeature[metrics]>=${maj}.${min},<${Number(maj) + 1}`,
);
```

Khớp đúng tệp hôm nay, không cần `semver` lẫn `packaging` (cả hai đều **không** là dependency của design-lint;
`packaging` chỉ đến gián tiếp qua `twine`, và dựa vào một transitive cho một cổng là fail-open). Đợt này **không
thêm dependency nào**, nên `pnpm-lock.yaml` không đổi.

### QĐ-10 — README của gói viết bằng tiếng Anh

`packages/openfeature-provider/README.md` (mới — gói Node hiện **không có** README nào) và `sdks/python/README.md`
(viết lại từ bản tiếng Việt 40 dòng hiện có).

- **Vì sao tiếng Anh:** README này KHÔNG phải tài liệu của repo mà là **trang gói** trên npm và PyPI. Người đọc nó
  là người tích hợp OpenFeature, ở đâu cũng được. Tài liệu thiết kế của khoá luận vẫn tiếng Việt và README trỏ về đó
  bằng URL tuyệt đối (`https://github.com/23521549-lang/udp/blob/main/docs/UDP_design.md`) — đường dẫn tương đối
  không mở được từ trang npm.
- **Phải nói cả giới hạn:** không có tuỳ chọn fail-closed, `./testing` không có trong bản phát hành, regex chỉ nhận
  ngữ pháp khả chuyển (D-P35). Một trang gói chỉ nói điều hay là một trang gây tranh cãi ở issue đầu tiên. (§6.8 nói
  lý do fail-closed "ghi ở §16" nhưng §16 **không có** dòng đó — 62c-1 thêm, rồi README mới trích được.)

### QĐ-11 — Cổng mới nằm cùng chỗ với cổng đang có, và KHÔNG nhân bản cổng đã có

| Tính chất                                     | Đã có cổng ở đâu                                                                              | Đợt này                           |
| --------------------------------------------- | --------------------------------------------------------------------------------------------- | --------------------------------- |
| `dependencies` của gói Node rỗng              | `package-boundaries.test.ts:258` (manifest nguồn) **và** `package.test.ts:125` (đã pack)      | giữ nguyên, **không** thêm        |
| `publishConfig.exports` không có `./testing`  | `package.test.ts:126` — đọc `exports` của manifest **đã pack**, tức đo artifact khách nhận    | giữ nguyên, **không** thêm        |
| Tarball không có gì ngoài hợp đồng            | `package.test.ts:103-110` — và nó **đỏ** sau 62a (xem 62a-5)                                  | sửa cho đúng hợp đồng mới         |
| Cấu trúc workflow, "không `secrets.`"         | `deploy/tests/ci-workflow.test.ts` — đã canh cả ba workflow, đã có `not.toMatch(/secrets\./)` | thêm một `describe` cho `publish` |
| `files` đúng `["dist"]`; `license`; `LICENSE` | **chưa có cổng nào** (đã grep)                                                                | thêm                              |
| Đúng một package workspace không `private`    | **chưa có cổng nào** — không chỗ nào đọc `private`                                            | thêm                              |

- Ô "đúng **một** package không `private`" chứ không "hai": `sdks/python` **không** là thành viên pnpm workspace
  (`pnpm-workspace.yaml` khai `packages/* services/* apps/* deploy`, và `sdks/python` không có `package.json`). Hôm
  nay cả 21 thành viên + gốc đều `private`. Viết "hai" thì cổng hoặc đỏ mãi, hoặc tệ hơn: ai đó "sửa" bằng cách bỏ
  `private` của một package khác — đúng thoái cấp mà AC-7 tồn tại để chống.
- Bộ đọc hiện tại quét **ba** thư mục viết cứng (`["packages", "services", "apps"]`) nên **không thấy `deploy`** —
  một lỗ fail-open im lặng đúng ở package đang giữ cổng workflow. Đợt này lấy danh sách thành viên từ
  `pnpm-workspace.yaml` và thêm một ô khẳng định **số** thành viên tìm thấy, đúng loại ô "đếm phải khớp" mà
  `chartPinsOf` thiếu.
- **`actionlint` KHÔNG được dùng làm cổng.** Nó không tồn tại trong repo (grep ra đúng hai tệp, cả hai là plan #62),
  và nó kiểm cú pháp chứ không kiểm "`id-token: write` ở đúng hai job", "không `secrets.`", "có `--provenance`". Một
  bản dựng thử đúng hình dạng "dispatch publish thật" cho `actionlint` exit 0. AC-3 và AC-4 giao cho
  `ci-workflow.test.ts`.

## 3. Ngoài phạm vi (nêu rõ)

- **Lượt publish thật lên npm và PyPI.** Nó đòi tài khoản của chủ repo (AC-8). Đợt này đưa mọi thứ tới chỗ chỉ còn
  một lượt bấm, và ghi lệnh ra.
- **`npm stage publish`** (staged publishing: một bản staged duyệt bằng 2FA ở registry và **từ chối được**, tức một
  chốt có đường lùi — mạnh hơn `environment`). Nó đòi npm ≥ 11.15.0 và, với gói chưa tồn tại, npm đăng một version
  giữ chỗ **công khai** `0.0.0-stage`. Một đường phát hành thứ hai cho cùng một gói là một quyết định riêng; đợt này
  chỉ ghi nó vào lộ trình.
- **Phát hành `@udp/flag-evaluator` riêng.** Lõi đánh giá được GÓP VÀO bundle của provider (§6.8) — phát hành nó
  thành gói riêng là một bề mặt công khai thứ hai cho cùng một ngữ nghĩa, và I26 sẽ phải giữ hai bản.
- **Nâng `pnpm`** để bỏ bước dẫn xuất (QĐ-3).
- **Changelog và quy trình bump cho bản sau** (`0.1.1`, `0.2.0`…). Đợt này làm một đường phát hành chạy được cho bản
  đầu; quy ước bump và changelog không có consumer nào trong đợt này (R6).
- **Gói cho ngôn ngữ khác** (§17).

## 4. Kiểm chứng

| Việc                                  | Lệnh                                                                                                                                            | Thứ phải thấy                                                                         |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| Artifact npm đúng hợp đồng            | `pnpm -C packages/openfeature-provider exec tsx scripts/pack.ts --out <dir>`                                                                    | 11 tệp; manifest không `private`, không `@udp/*`, không `scripts`, `main` trỏ `dist/` |
| Và nó publish được                    | `npm publish <tgz> --dry-run --access public`                                                                                                   | `total files: 11`, `+ @udp/openfeature-provider@0.1.0`                                |
| Artifact PyPI                         | `python -m build` ở `sdks/python`                                                                                                               | sdist + wheel; wheel không có mã nào ngoài `udp_openfeature/`                         |
| Metadata PyPI đọc được                | `twine check --strict dist/*`                                                                                                                   | `PASSED` (không "with warnings"), exit 0                                              |
| Giấy phép NẰM TRONG artifact PyPI     | bốn lệnh: `METADATA` có `License-Expression: Apache-2.0` và `License-File: LICENSE`; wheel có `dist-info/licenses/LICENSE`; sdist có `/LICENSE` | cả bốn exit 0                                                                         |
| Notices khớp bundle                   | `tsx scripts/build.ts` (có `metafile`)                                                                                                          | số khối của `THIRD_PARTY_NOTICES` = số package bên thứ ba trong metafile; lệch ⇒ ném  |
| Cổng hình dạng, lockstep, Golden Path | `pnpm --filter @udp/design-lint test`                                                                                                           | ô mới xanh; và đỏ khi cố tình làm lệch (R11)                                          |
| Cổng cấu trúc workflow                | `pnpm --filter @udp/deploy test`                                                                                                                | `describe("Publish SDK")` xanh                                                        |
| Hai bộ test của gói không hồi quy     | `pnpm --filter @udp/openfeature-provider test` **&&** `… typecheck`; `sdks/python` bốn cổng                                                     | như trước đợt này                                                                     |
| Biến ẩn của hai phép đo Python        | `pip --version`, `twine --version`, `python -c "import setuptools;print(setuptools.__version__)"`                                               | dán vào báo cáo                                                                       |

**Đường lùi (R10):** mọi thứ của đợt này là tệp mới hoặc trường thêm vào manifest; `git revert` một commit là đủ.
Thứ **không** lùi được là một lượt publish thật — và đúng vì thế nó nằm ngoài phạm vi, sau một chốt duyệt tay.

**Kiểm thoái cấp (R11) — trả bằng ô test, mỗi ô phải ĐỎ khi cố tình làm lệch:** (a) đúng một package workspace không
`private`, và bộ đọc thấy đủ **mọi** thành viên kể cả `deploy`; (b) `files` đúng `["dist"]`; (c) artifact phát hành
không có khoá `@udp/*` nào và không có `scripts`; (d) `exports` của manifest **đã pack** đúng `.` và `./metrics` (ô
đang có — kiểm bằng một lượt thêm `./testing`); (e) `dependencies` rỗng (ô đang có); (f) hai version bằng nhau;
(g) `PROVIDER_RELEASE` và `requirements.txt` đúng chuỗi tính ra từ version; (h) `THIRD_PARTY_NOTICES` khớp metafile
của bundle; (i) `publish.yml` không nhắc `secrets.`, có `--provenance`, ghim npm không phải `latest`, và action bên
thứ ba ghim 40 ký tự hex.
