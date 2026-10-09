# Plan #63 — Spec: lượt CI đầu tiên trên GitHub đỏ ở bốn job, và vì sao

Nối tiếp Plan #61 và #62 (nhánh `p61-dong-goi`, PR `23521549-lang/udp#1`). Giữ nguyên mọi quyết định của hai plan đó:
pnpm 9.12.0 qua `packageManager`, Node dòng 22, hướng phụ thuộc `@udp/*`, các cổng hiện có, chi phí hạ tầng 0 (D-P37).

## 1. Khởi phát — một dữ kiện mà bàn giao 04/10 không có

Bàn giao 04/10 ghi "Plan #61 đã ĐÓNG" và "không còn việc nào plan được mà máy làm được". Nhưng nhánh `p61-dong-goi`
(Plan #16 tới #62, 208 commit trước `origin/main`) **chưa từng xanh trên GitHub**: `origin/main` còn ở Plan #15, và
PR `#1` là lượt đầu tiên toàn bộ mã này chạy trên runner. Lượt đó (run `37154337078`, 03/10 21:13 UTC, đúng commit
`ac149ba` là đỉnh nhánh hôm nay) **đỏ bốn job**:

| Job                    | Bước đỏ                         | Dòng lỗi (nguyên văn log)                                                                                     |
| ---------------------- | ------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `signing-e2e`          | công cụ ký (bước đầu tiên chạy mã) | `Cannot find module '.../packages/db/src/generated/prisma/client.js' imported from .../packages/db/src/index.ts` |
| `test`                 | `pnpm test:scratch`             | `fixture-constants.test.ts:226` `expected 'b047af…' not to be 'b047af…'`, rồi `has timed out after 40 minutes` |
| `kind`                 | E2E rút gọn                     | `connect ECONNREFUSED 127.0.0.1:8080` — bước `pnpm deploy:up` trước đó **xanh trong 7,6 giây**                |
| `vm`                   | `release.sh`                    | `rollout status deployment/core-backend ... timed out`; pod: `CORE_BACKEND_PORT: Expected number, received nan` |

`build-smoke` không chạy (chỉ chạy ngoài PR). Bốn job xanh: `check`, `python`, `portal-demo`, `i28`.

Sổ nợ đã thừa nhận trước điều này (§16, dòng Plan #50: "`pnpm deploy:up` lần đầu chạy thật là ở job `kind` sau lần
push đầu tiên"). Lượt push đầu tiên đã xảy ra; đợt này đọc kết quả của nó.

## 2. Bốn gốc lỗi — mỗi cái đã đo, không suy đoán

**G1 — mã công cụ mà CI chạy NGOÀI tiến trình service lại nạp cấu hình runtime của service.** Đồ thị import đo bằng
esbuild (`metafile`, đi theo mã `@udp/*`, gói bên thứ ba để ngoài): `scripts/signing-e2e.ts` → `signature-gate.ts` →
`packaging/signing-keys.ts` → `ValidationError` lấy từ **entry chính** của `@udp/http` → `error-handler.ts` → `@udp/db`
(client Prisma, bị gitignore nên runner không có — đúng dòng lỗi CI) **và** `logger.ts` → entry chính của `@udp/config`
→ `env.ts`, tệp `safeParse(process.env)` rồi **ném** ngay lúc nạp. Sinh client thôi là **không đủ**: đo `envSchema` trên
đúng env của job (`DATABASE_URL_DIRECT` giả + `NODE_ENV=test`) ⇒ thiếu **12** biến bắt buộc. Entry chính của cả hai
package cố ý như vậy (chú thích đầu `packages/http/src/index.ts`: "nạp module là chạy validate toàn bộ env — cố ý"), và
repo đã có quy ước cho nơi KHÔNG có env: subpath thuần (`@udp/config/build-toolchain`, `/constants`, `/env-schema`).

Quét mọi entry mà một job **không có cấu hình service** chạy (mọi job trừ `test`): **năm** cái nạp `env.ts`, bốn cái
chưa lộ vì job của chúng chưa từng chạy tới đó (dòng thứ năm do QA C-12 tìm ra — một `import()` động với chuỗi literal,
mà esbuild có đi theo):

| Entry                               | Job                                   | Nạp                    | Trạng thái hôm nay                          |
| ----------------------------------- | ------------------------------------- | ---------------------- | ------------------------------------------- |
| `core-backend/scripts/signing-e2e.ts` | `signing-e2e`                         | `env.ts`, `db/index.ts` | đỏ                                          |
| `core-backend/scripts/build-smoke.ts` | `build-smoke` (chỉ sau merge)         | `env.ts`               | sẽ đỏ trên `main` (qua `build-script.ts`)   |
| `deploy/e2e-vm/vm.e2e.test.ts`      | `vm`, bước E2E                        | `env.ts`, `db/index.ts` | sẽ đỏ ngay sau khi sửa G4                   |
| `deploy/tests/vm.test.ts`           | `gate` của `publish.yml`              | `env.ts`, `db/index.ts` | sẽ chặn lượt phát hành SDK đầu tiên         |
| `design-lint/tests/references.test.ts` | `gate` của `publish.yml`           | `env.ts` (`await import("@udp/config")`) | sẽ chặn lượt phát hành SDK đầu tiên |

Bảy entry bẩn còn lại (`experiments/scripts/e3`, `e4`, `e5`, `e5-setup`, `i34`, và `chart-values-audit`,
`measure-flag-list` của `core-backend`) là harness đo chạy CÙNG database, không job CI nào gọi — chúng cần env, đúng
thiết kế.

**G2a — cổng thứ tự của `adapter-core` đọc lịch sử git trên một bản clone nông.** `actions/checkout@v4` của job `test`
chạy `fetch-depth: 1` (log: `fetch-depth: 1`). Trên bản clone một commit, `git log --diff-filter=A` trả **cùng một
commit** (commit merge của PR) cho cả `fixture.ts` lẫn `sim-adapter.ts`, nên `expect(fixtureCommit).not.toBe(adapterCommit)`
đỏ. Ở máy (clone đủ): `cba76a5` và `5397c62` — hai commit khác nhau, đúng thứ tự. **Cùng hình dạng, chiều ngược lại
(QA A2):** bất biến I35(a) (`design-lint/tests/oracle-independence.test.ts`) so `oracle.at <= resolver.at` — trên clone
nông hai mốc là CÙNG một commit nên `at <= at` **xanh mà không kiểm gì**, và nó đã xanh như thế ở chính lượt đó.

**G2b — bộ test đầy đủ cần ~64 phút, bước bị chặn ở 40.** Đo, không ước: các gói trước `core-backend` mất **21,5
phút** trên CI (21:14:04 → 21:35:36); `core-backend` cả 157 tệp mất **2283 giây** ở máy ngày 04/10 (log đầy đủ của
phiên Plan #62); tệp nặng nhất (`provision-job.integration.test.ts`) CI/máy = 747/678 = **1,10**. Ước tính trên CI:
21,5 + 2283 × 1,10 / 60 ≈ **63,5 phút**. Lúc hết 40 phút, `core-backend` mới xong 6 tệp. Không phải treo: mỗi ô của
`provision-job` chạy một lượt provisioning đầy đủ trên database từ xa (~20 giây/ô, chú thích trong tệp đã ghi).

**G3 — `pnpm --filter @udp/deploy up` không chạy script `up`, mà chạy `pnpm update`.** Đo bằng chính pnpm 9.12.0
của repo: `pnpm --filter @udp/deploy up --help` ⇒ `Usage: pnpm update ... Aliases: up, upgrade`. Lệnh có sẵn thắng
script cùng tên. Log CI khớp: bước `pnpm deploy:up` in `Lockfile only installation will make it out-of-date` rồi
`Done in 7.6s` — không cụm nào được dựng. Ở máy dev thì nặng hơn: `pnpm deploy:up` **sửa `package.json` và lockfile**
của `@udp/deploy`. Dò cả 71 tên script của workspace bằng script đánh dấu (§5 QĐ-4): **chỉ `up`** bị một lệnh có
sẵn chiếm (`test`, `start` thì pnpm cố ý chuyển về script).

**G4 — kubelet tiêm biến "service link" trùng tên với cấu hình cổng của UDP.** Service `core-backend`,
`flag-service`, `pd-controller`, `portal` sinh `CORE_BACKEND_PORT=tcp://10.43.x.x:3001`… trong mọi pod cùng namespace
(`enableServiceLinks` mặc định `true`). ConfigMap không đặt bốn khoá `*_PORT`, mà kubelet chỉ lấp khoá **chưa có**
từ `env`/`envFrom` ⇒ `@udp/config` đọc `tcp://…` ⇒ `NaN` ⇒ cả ba service crash. Test tại chỗ không bắt được vì
`effectiveEnv` của `vm.test.ts` tự nhận "env thật của container" mà **bỏ sót đúng lớp này**; test của overlay `kind`
còn ghép ConfigMap + Secret trực tiếp. Lỗi chỉ chưa lộ ở `kind` vì `kind` gãy sớm hơn (G3).

## 3. Hai rủi ro sắp tới, cùng loại "môi trường đổi dưới chân"

**Nhãn runner.** Mọi job của lượt đó mang chú thích của GitHub: *"The ubuntu-latest label will migrate to Ubuntu 26
beginning October 19, 2026"*. Job `vm` là **diễn tập** máy công khai chạy Ubuntu 24.04 (`deploy/vm/bootstrap.sh:2`);
sau 19/10 nó sẽ diễn tập trên một hệ điều hành khác máy thật. Nhưng hai job `build-smoke` và `signing-e2e` diễn tập
**pipeline mà UDP sinh cho khách**, và pipeline đó chạy `runs-on: ubuntu-latest`
(`cicd-adapter/github-actions/index.ts`, hai chỗ) — chúng phải chạy đúng nhãn của khách, không ghim riêng (QA A7).

**Concurrency.** Bộ test dài từ ~5 phút (dòng §13.5 "5 phút 20 giây") lên ~64 phút. Group cấp workflow của `ci.yml`
là `${{ github.workflow }}-${{ github.ref }}` với `cancel-in-progress: true`: lượt đêm (`schedule`, cùng ref `main`)
**huỷ** lượt push-main đang chạy và ngược lại. Một commit `main` kết thúc `cancelled` thì `Deploy` không chạy (nó đòi
`conclusion == success` của lượt push), và một tag đặt trên commit đó trượt cổng `publish.yml` ("ci.yml đã xanh trên
đúng commit") — QA A6.

## 4. Phạm vi

Trong: bốn gốc lỗi cùng mọi chỗ cùng hình dạng mà phép quét tìm ra (ba entry bẩn chưa lộ, I35 trên clone nông), cổng
chặn từng loại, nhãn runner, concurrency, tài liệu (§3.1, §13.5, §15.1, §16, D-P37 → D-P55), sổ nợ, README.

Ngoài, có lý do:
- **Chạy CI thật** — cần push, việc của chủ repo; ghi ở sổ nợ `ci-github-green` (hai pha: trên PR, rồi sau merge vì
  `build-smoke`, `Deploy`, `toolchain.yml` và lượt chạy tay chỉ có trên `main`).
- **Ghim nhãn runner của pipeline sinh cho KHÁCH** — một thay đổi hành vi sản phẩm (mọi project GitHub Actions), kéo
  theo nghĩa vụ theo dõi ngày GitHub bỏ nhãn; không phải lỗi. Đợt này chỉ đưa nhãn đó thành MỘT hằng để hai job diễn
  tập đọc cùng nguồn.
- **`enableServiceLinks` cho manifest Golden Path của khách** — ứng dụng của khách đọc cấu hình của chính nó; cùng lý
  do sản phẩm như trên (QA G5). Câu chữ của đợt này là "mọi pod template của bản triển khai UDP".
- **Job `vm` trên runner arm64** (`ubuntu-24.04-arm`, máy thật là Ampere A1) — một biến mới chưa đo; đổi một biến mỗi
  lần, sau khi x86 xanh (QA G2).
- **Nâng action lên bản Node 24** — cảnh báo, chưa hỏng.

## 5. Quyết định

**QĐ-1 — Entry mà CI chạy ngoài tiến trình service đi qua subpath THUẦN; một cổng đo đồ thị import giữ điều đó.**
Tiền lệ của chính thiết kế: 61d-3c (§5, dòng "Vì sao ghim rời khỏi tệp adapter") gặp đúng hình dạng này với
`chart:check` trên runner không có `.env`, và giải bằng dữ liệu thuần chứ không bằng cấp env.
`@udp/http` thêm hai subpath thuần `./errors` (chỉ phụ thuộc `@udp/shared-types/problem`) và `./flagger-gate` (chỉ
`node:crypto`); sáu chỗ import đổi sang subpath: `build-script.ts` và `sign-script.ts` lấy `BUILD_TOOLCHAIN`,
`SIGNING_CONFIG_JSON` từ `@udp/config/build-toolchain` (nơi chúng được định nghĩa); `signing-keys.ts` lấy
`ValidationError` từ `@udp/http/errors`; `deploy/tests/vm.test.ts` và `deploy/e2e-vm/vm.e2e.test.ts` lấy
`flaggerGatePath` từ `@udp/http/flagger-gate`; `references.test.ts` lấy `DOMAIN_CATALOG_SEED` từ
`@udp/config/domains`. Entry chính của hai package **giữ nguyên** fail-fast.
Cổng `packages/design-lint/tests/ci-entry-purity.test.ts` (esbuild `metafile`): danh sách entry = glob khai tường minh
cho `deploy/` và thư mục `scripts/` chạy không env, **cộng** mọi tệp mà workflow gọi trực tiếp (`exec tsx <tệp>`,
`exec vitest run <tệp…>`, theo đúng package của lệnh, mỗi tệp suy ra phải tồn tại). Tệp cấm: `config/src/env.ts`,
`db/src/index.ts` và mọi thứ dưới `db/src/generated/` (lớp lỗi riêng: chính dòng lỗi CI — QA C-15); chúng bị chặn ở
`onLoad` (vẫn được thấy, không cần client Prisma đã sinh). Đỏ khi đồ thị chứa tệp cấm, **hoặc** chứa một tệp có
`import()` với đối số không phải chuỗi literal — esbuild không đi theo cạnh đó và không cảnh báo (đo trên
`domain-adapter.registry.ts`), nên đó là chỗ cổng mù và phải đỏ thay vì xanh (QA A5, C-14). Plugin chỉ để ngoài
specifier có hình dạng tên gói npm hay `node:`; specifier lạ (alias, `#imports`) ném thay vì bị cắt im lặng (QA C-16).
Lỗi build là đỏ, không bị bỏ qua. Fail-closed: đối chứng dương `services/core-backend/src/index.ts`, và tập suy ra
từ workflow phải ⊇ những tệp đã biết. `portal-demo` ngoài danh sách: vite bundle cho trình duyệt — entry chính của
`@udp/config` (dotenv, `node:path`) không vào được đó mà build còn xanh (QA C-17).
_Bác:_ (a) thêm `pnpm db:generate` vào job — đo ra không đủ, `env.ts` ném ngay sau (thiếu 12 biến); (b) cấp cho mọi
job bộ env vứt-đi đầy đủ — trao cho công cụ cấu hình service nó không dùng, và che đúng sự ràng buộc vừa tìm ra
(`publish.yml` tự tuyên bố cổng của nó "không cái nào chạm database"); (c) làm `env.ts` nạp lười — phá hợp đồng
fail-fast mà chính tệp đó ghi lý do. Giá: `esbuild@0.28.2` (bản `openfeature-provider` đang ghim) thành devDependency
của `design-lint`.

**QĐ-2 — Job `test` clone đủ lịch sử, và hai phép kiểm đọc lịch sử tự nói ra khi lịch sử bị cắt.** `fetch-depth: 0`;
`fixture-constants.test.ts` (cổng thứ tự của `adapter-core`) và `oracle-independence.test.ts` (I35) mỗi tệp thêm một ô
đầu: `git rev-parse --is-shallow-repository` là `false`, thông điệp chỉ thẳng cách sửa. Hai ô viết tại chỗ chứ không
qua một helper chung: hai tệp ở hai package, và `adapter-core` không được phụ thuộc thứ gì kéo `@udp/db`.
_Bác:_ bỏ qua ô khi clone nông — đúng loại xanh-vì-không-kiểm mà chú thích của chính khối đó cấm.

**QĐ-3 — Trần của bước `test:scratch` là 90 phút, ghi căn cứ đo ngay cạnh.** 63,5 phút ước từ số đo × 1,4.
_Bác:_ (a) chia shard song song — ngân sách 60 kết nối của project CI, một lượt đã dùng ~33 (chú thích của chính
job), hai lượt song song là vượt; (b) PostgreSQL trong container — runner CÓ Docker nên lý do (1) của §13.5 không
áp, nhưng mất hai lý do còn lại: đúng phiên bản và nền tảng (PostgreSQL sau Supavisor) và I22 kiểm thật role của nhà
cung cấp; (c) giữ 40 — bộ test không bao giờ chạy hết. Trần vẫn là chốt chặn treo: 90 ≪ 360 phút mặc định.

**QĐ-4 — Script của `@udp/deploy` đổi thành `kind-up`/`kind-down`; cổng cấm tên script trùng lệnh có sẵn của pnpm.**
Khớp quy ước `vm-up`, `vm-restore` đã có. Lệnh gốc `pnpm deploy:up`/`deploy:down` giữ nguyên. Cổng ở một tệp riêng
`packages/design-lint/tests/script-names.test.ts` (KHÔNG ở `package-boundaries.test.ts`, mà `publish.yml/gate` chạy và
thiết kế mô tả là "đọc tệp" — QA A3). **Phép dò bằng script đánh dấu:** một thư mục tạm có `packageManager` đúng bản
ghim của gốc và MỌI tên làm script `echo UDP_MARK_<i>`; `pnpm <tên> --help` in ra dấu của nó ⇔ script thắng.
_Bác:_ (a) dò trong thư mục RỖNG theo mã thoát (bản nháp) — tên không phải lệnh có sẵn rơi về `exec` và **chạy chương
trình cùng tên trên PATH** (đo: cmd.exe chạy `node --help`, `git --help`; gốc repo có script `format` mà trên Windows
`format` là trình định dạng ổ đĩa); `exec` là lệnh có sẵn nhưng thoát 1 (xanh giả), `node` thoát 0 dù script thắng
(đỏ giả) — QA C-1..C-3; (b) `pnpm --filter @udp/deploy run up` — CI xanh, nhưng `pnpm -C deploy up` vẫn chạy
`pnpm update` và sửa lockfile; (c) danh sách lệnh viết tay — lệch im lặng khi nâng pnpm, và không biết các lệnh pnpm
chuyển sang npm (`version`, `view`…).

**QĐ-5 — `enableServiceLinks: false` ở mọi pod template của bản triển khai UDP, và mô hình env của test làm đúng như
kubelet.** Chín workload: bảy ở `k8s/base` (năm Deployment, StatefulSet `postgres`, Job `udp-migrate`), Deployment
`sample-app` ở overlay `kind`, CronJob `udp-backup` ở overlay `vm` (`overlays/kind/seed.yaml` là bản vá của
`udp-migrate`). `effectiveEnv` chuyển vào `deploy/tests/kustomize.ts` và theo `pkg/kubelet` (đọc mã v1.34.0): `envFrom`
theo thứ tự, mọi mục `env` (kể cả `valueFrom`) đè và chiếm khoá, rồi biến service link lấp khoá **chưa có** — của mọi
Service cùng namespace có ClusterIP khi `enableServiceLinks !== false`, và của Service `kubernetes` **bất kể cờ**
(kubelet luôn tiêm service master; `platform-probe.ts` dựa vào nó). Ô cấu trúc: mọi Deployment/StatefulSet/Job/CronJob
của hai overlay mang cờ, đếm đúng số workload kỳ vọng, và không có kind nào khác mang pod template.
_Bác:_ (a) đặt tường minh bốn khoá `*_PORT` trong ConfigMap — chữa bốn tên, Service thứ năm trùng một biến tương lai
lại gãy im lặng; (b) đổi tên Service — tên là địa chỉ DNS mà ConfigMap, nginx và Prometheus cùng dùng.

**QĐ-6 — Job của UDP chạy trên `ubuntu-24.04`; hai job diễn tập pipeline của khách chạy đúng nhãn của pipeline đó,
đọc từ một hằng.** `GITHUB_ACTIONS_RUNNER = "ubuntu-latest"` vào `@udp/config/build-toolchain`; `github-actions/index.ts`
dùng nó ở hai chỗ (đầu ra không đổi một byte). Cổng ở `ci-workflow.test.ts`: `build-smoke`, `signing-e2e` có `runs-on`
bằng hằng đó; mọi job khác của năm workflow không chạy trên nhãn `-latest`.

**QĐ-7 — README và cây §3.1 nói đúng về repo.** README: "Yêu cầu" theo `engines`/`packageManager` (hôm nay "Node.js ≥
20" trong khi repo đòi `>=22.22.2`), cây thư mục đủ mọi package của workspace (thiếu `adapter-core`,
`cloud-adapters`, `cluster-access`, `golden-path`, `deploy/`, `sdks/python`). Cổng ở tệp riêng
`packages/design-lint/tests/readme.test.ts`. §3.1 của thiết kế: thêm các package còn thiếu (QA G3) và hai subpath mới
của `@udp/http` (QA A4).

**QĐ-8 — Lượt push-main và lượt đêm không huỷ nhau.** Group cấp workflow của `ci.yml` thêm `github.event_name`,
`cancel-in-progress` chỉ đúng với `pull_request`: một PR bị đẩy tiếp vẫn huỷ lượt cũ (tiết kiệm runner), còn lượt của
`main` — thứ `Deploy` và cổng phát hành đọc — không bị huỷ. Phần còn lại của rủi ro nằm ở group `udp-ci-scratch-database`
của job `test` (GitHub chỉ giữ MỘT lượt chờ; lượt chờ cũ bị thay): chấp nhận, vì nới nó là vượt ngân sách 60 kết nối;
ghi một dòng §16 kèm cách gỡ (chạy lại job).

## 6. Tiêu chí chấp nhận

- **AC-1** Cổng `ci-entry-purity` **đỏ** trên mã hiện tại ở đúng năm entry của bảng G1, **xanh** sau khi đổi sáu chỗ
  import; đối chứng dương đỏ đúng; đồ thị có `import()` không literal thì đỏ.
- **AC-2** Job `test` có `fetch-depth: 0` và trần 90 phút kèm căn cứ (cổng); hai ô clone-nông có trong hai tệp.
- **AC-3** Không tên script nào bị lệnh có sẵn của pnpm 9.12.0 che (cổng, ba đối chứng); đỏ trước khi đổi tên, xanh sau.
- **AC-4** Mô hình env: **đỏ** trên manifest hiện tại với đúng bốn khoá `*_PORT`, **xanh** sau `enableServiceLinks:
  false`; mọi workload của hai overlay mang cờ, đếm đủ.
- **AC-5** `build-smoke`, `signing-e2e` chạy nhãn của pipeline khách (hằng); không job nào khác chạy nhãn `-latest`.
- **AC-6** README và §3.1: cổng `readme.test.ts` xanh; đỏ khi bỏ một package khỏi cây.
- **AC-7** Concurrency: group có `github.event_name`, chỉ PR bị huỷ (cổng).
- **AC-8** Tài liệu: §3.1, §13.5 (thay số "5 phút 20 giây", ghi hệ quả tới `Deploy`/cổng phát hành), §15.1 (câu
  "cấu hình mà service từ chối là test đỏ, không phải pod crash" — QA A1), §16 (dòng Plan #50 và dòng concurrency mới),
  hàng D-P55; mục nợ `ci-github-green` (sổ: 53 mục); bàn giao 09/10.
- **AC-9** Mọi cổng đã chạm xanh tại chỗ: `@udp/deploy` test, các tệp `design-lint` đã đổi, `fixture-constants`,
  typecheck các package đã đổi, eslint + prettier trên tệp đã đổi. CI thật: sổ nợ `ci-github-green`.
