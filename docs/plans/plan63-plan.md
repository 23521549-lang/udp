# Plan #63 — Kế hoạch: bốn gốc lỗi của lượt CI đầu tiên, và cổng cho từng loại

Spec: `docs/plans/plan63-spec.md`. Mỗi đợt: cổng viết TRƯỚC và chạy cho thấy đỏ trên mã hiện tại, rồi sửa, rồi xanh,
rồi một commit một dòng tiếng Anh (chỉ ở máy — không push).

Đợt này chạm ~35 tệp, một interface công khai của package (`exports` của `@udp/http`), một hằng mới của
`@udp/config/build-toolchain`, manifest của workspace và năm workflow ⇒ **trên ngưỡng R2**: ba agent QA đã chạy trên
bản nháp trước dòng mã đầu; phần cuối ghi từng chỗ plan bị bẻ.

**Nối tiếp (R3):** Plan #61, #62. Giữ nguyên: `packageManager: pnpm@9.12.0`, Node dòng 22 (`engines >=22.22.2`), hướng
phụ thuộc `@udp/*` và tám ô của `package-boundaries.test.ts`, entry chính của `@udp/config`/`@udp/http` fail-fast,
quy ước tên `vm-up`/`vm-restore`, `esbuild@0.28.2` (bản `openfeature-provider` ghim), mọi cổng của
`ci-workflow.test.ts`, đầu ra của pipeline GitHub Actions sinh cho khách (không đổi một byte).

**Mốc lùi (R10):** đỉnh `ac149ba`, cây sạch. Mỗi đợt một commit ⇒ lùi từng đợt bằng `git revert`. Đợt 63a đổi
`pnpm-lock.yaml`: bản sao trước khi sửa ở scratchpad (`backup/pnpm-lock.yaml.ac149ba`, sha256 `9cf3ab23…`).

---

## 63a — Entry của CI đi qua subpath thuần (QĐ-1, AC-1)

### 63a-1. Bộ đọc workspace dùng chung

- **Làm gì:** chuyển `workspaceGlobs`, `readWorkspacePackages`, kiểu `Manifest`/`Pkg` (thêm `scripts?`, `engines?`,
  `packageManager?`) từ `package-boundaries.test.ts` sang `packages/design-lint/tests/workspace.ts`; thêm
  `readRootManifest()`. Không đổi logic.
- **Ở đâu:** `packages/design-lint/tests/workspace.ts` (mới), `package-boundaries.test.ts` (import thay vì định nghĩa).
- **Hệ quả:** ba tệp test mới dùng chung một bộ đọc fail-closed (bài học 62b-2: một bộ đọc thứ hai là một lỗ quét).
- **Lan sang:** `publish.yml/gate` chạy `package-boundaries.test.ts` — tệp helper là import tương đối, không phụ thuộc mới.
- **Ai dùng hôm nay:** `package-boundaries.test.ts`, `ci-entry-purity.test.ts`, `script-names.test.ts`, `readme.test.ts`.

### 63a-2. Cổng `ci-entry-purity.test.ts` (viết trước, đỏ ở năm entry)

- **Làm gì:** thêm mới. Mỗi entry: `esbuild.build({ entryPoints: [entry], absWorkingDir: ROOT, bundle: true,
  write: false, metafile: true, platform: "node", format: "esm", logLevel: "silent", plugins })`. Plugin:
  (a) `onResolve` cho specifier trần: `@udp/*` đi theo; khớp hình dạng tên gói npm hay `node:` ⇒ để ngoài; còn lại ⇒
  ném (alias/`#imports` không được cắt im lặng — QA C-16); `kind: "entry-point"` đi theo;
  (b) `onLoad` cho tệp cấm (`packages/config/src/env.ts`, `packages/db/src/index.ts`, `packages/db/src/generated/**`)
  trả nội dung rỗng — tệp vào `metafile.inputs`, đồ thị dừng ở đó, cổng không cần client Prisma đã sinh (QA B3, C-15).
  Hai luật đỏ: (1) khoá của `metafile.inputs` (tương đối với ROOT, `/`) chứa tệp cấm — thông điệp là đường import
  ngắn nhất (BFS trên `inputs[*].imports`); (2) một tệp UDP trong đồ thị (không thuộc `node_modules`) có `import(`
  với đối số không bắt đầu bằng dấu nháy — đọc nguồn sau khi bỏ chú thích; esbuild không đi theo cạnh đó và không cảnh
  báo (đo trên `domain-adapter.registry.ts:297`), nên đồ thị "không đóng" phải đỏ (QA A5, C-14). Lỗi build ⇒ đỏ.
  **Danh sách entry:** `git ls-files` của `deploy/src/*.ts`, `deploy/tests/*.ts`, `deploy/e2e/*.ts`,
  `deploy/e2e-vm/*.ts`, `packages/config/scripts/*.ts`, `packages/design-lint/scripts/*.ts`,
  `packages/openfeature-provider/scripts/*.ts`, `packages/experiments/scripts/e9.ts`; **cộng** mọi tệp mà một workflow
  gọi theo tên, đọc từ văn bản thô của `.github/workflows/*.yml` (lệnh ở cả `run:` lẫn `env:` — biến `E2E`):
  `(--filter <@udp/pkg> | -C <thư mục>) exec tsx <tệp>` và `(--filter … | -C …) exec vitest run <tệp…>`, tên package ra
  thư mục bằng bộ đọc workspace (QA B1, C-13). Mọi tệp suy ra PHẢI tồn tại.
  **Fail-closed:** mỗi glob ra ≥ 1 tệp; tập suy ra ⊇ `services/core-backend/scripts/{build-smoke,signing-e2e}.ts`,
  `packages/design-lint/tests/{package-boundaries,debt-ledger,references}.test.ts`, `packages/design-lint/scripts/
  sdk-version.ts`, `packages/openfeature-provider/scripts/pack.ts`; đối chứng dương `services/core-backend/src/index.ts`
  PHẢI chạm tệp cấm VÀ bị luật (2) bắt (registry). Timeout ô 120 giây.
- **Ở đâu:** `packages/design-lint/tests/ci-entry-purity.test.ts`; `packages/design-lint/package.json` thêm
  `devDependencies.esbuild: "0.28.2"`; `pnpm-lock.yaml` (`pnpm install --offline`).
- **Hệ quả:** mọi entry mà job không-env chạy được canh tại chỗ, trước push.
- **Lan sang:** ô "mỗi package khai đúng những @udp/* mà nó import" không đổi (esbuild không phải `@udp/*`).
- **Ai dùng hôm nay:** `pnpm --filter @udp/design-lint test` (job `test` qua `test:scratch`).

### 63a-3. Hai subpath thuần của `@udp/http`

- **Làm gì:** `exports` thêm `"./errors": "./src/errors.ts"`, `"./flagger-gate": "./src/flagger-gate.ts"`; chú thích
  đầu `src/index.ts` thêm một đoạn: entry chính vẫn fail-fast; hai subpath cho nơi không có env.
- **Ở đâu:** `packages/http/package.json`, `packages/http/src/index.ts` (chỉ chú thích).
- **Hệ quả:** `ValidationError` từ hai đường là cùng một lớp (cùng tệp) ⇒ `instanceof` trong `error-handler.ts` đúng.
- **Lan sang:** không package nào phải đổi khai báo phụ thuộc. §3.1 của thiết kế (63f).
- **Ai dùng hôm nay:** 63a-4.

### 63a-4. Sáu chỗ import

- **Làm gì:** chỉ đổi đường import:
  `services/core-backend/src/modules/adapter-base/packaging/build-script.ts` và `.../sign-script.ts`
  (`@udp/config/build-toolchain`), `services/core-backend/src/modules/packaging/signing-keys.ts` (`@udp/http/errors`),
  `deploy/tests/vm.test.ts`, `deploy/e2e-vm/vm.e2e.test.ts` (`@udp/http/flagger-gate`),
  `packages/design-lint/tests/references.test.ts` (`@udp/config/domains`).
- **Hệ quả:** cổng 63a-2 xanh; mã chạy y hệt (cùng tệp nguồn).
- **Ai dùng hôm nay:** job `signing-e2e`, `build-smoke`, `vm` (E2E), `publish.yml/gate`.

**Kiểm 63a:** `ci-entry-purity` đỏ đúng năm entry trước 63a-4, xanh sau; typecheck `@udp/http`, `@udp/deploy`,
`@udp/design-lint`; `package-boundaries.test.ts` xanh sau khi chuyển bộ đọc.

---

## 63b — Không tên script nào bị lệnh có sẵn của pnpm che (QĐ-4, AC-3)

### 63b-1. Cổng `script-names.test.ts` (viết trước, đỏ ở `up`)

- **Làm gì:** thêm mới. Tên = khoá `scripts` của manifest gốc và mọi package workspace, bỏ khoá `//…` và bốn tên vòng
  đời `test`, `start`, `stop`, `restart`; mỗi tên khớp `^[a-z0-9][a-z0-9:_-]*$`. Một thư mục `mkdtemp` có
  `package.json` = `{ packageManager: <của gốc>, private: true, scripts: { <tên_i>: "echo UDP_MARK_<i>" } }` gồm mọi
  tên cộng hai đối chứng `update` và `udp-mark-probe`. Ba ô: (1) `pnpm --version` ở đó = bản ghim (thông điệp nói
  `corepack enable`); (2) đối chứng: `pnpm update --help` KHÔNG ra dấu, `pnpm udp-mark-probe --help` RA dấu; (3) với
  mỗi tên, `pnpm <tên> --help` ra dấu của chính nó. Song song tối đa 4; timeout ô 240 giây; `shell: true` chỉ để tìm
  `pnpm.cmd`. Thư mục tạm xoá ở `afterAll`.
- **Ở đâu:** `packages/design-lint/tests/script-names.test.ts` — tệp riêng, KHÔNG ở `package-boundaries.test.ts` mà
  `publish.yml/gate` chạy và thiết kế gọi là "đọc tệp" (QA A3).
- **Hệ quả:** một script mang tên lệnh có sẵn (hôm nay `up`; mai là lệnh mà một bản pnpm mới thêm) đỏ tại chỗ; phép
  dò không bao giờ rơi về `exec` nên không chạy chương trình nào của PATH.
- **Ai dùng hôm nay:** job `test` (qua `test:scratch`).

### 63b-2. `up`/`down` → `kind-up`/`kind-down`

- **Làm gì:** đổi tên hai script; lệnh gốc `deploy:up`/`deploy:down` trỏ tên mới; chú thích `//deploy` thêm vì sao.
- **Ở đâu:** `deploy/package.json`, `package.json` (gốc).
- **Hệ quả:** `pnpm deploy:up` dựng cụm thật. README, CI, tài liệu gọi lệnh gốc — không đổi.
- **Lan sang:** không chỗ nào gọi `@udp/deploy up` trực tiếp (đã grep).
- **Ai dùng hôm nay:** job `kind`, README.

**Kiểm 63b:** ô (3) đỏ (`up`) trước 63b-2, xanh sau.

---

## 63c — Service link (QĐ-5, AC-4)

### 63c-1. Mô hình env dùng chung (viết trước)

- **Làm gì:** chuyển `effectiveEnv` từ `vm.test.ts` sang `deploy/tests/kustomize.ts`, theo `pkg/kubelet` v1.34.0
  (QA C-7..C-9): (i) `envFrom` theo thứ tự; (ii) MỌI mục `env` đè và chiếm khoá — `value`, `secretKeyRef` lấy từ bộ
  Secret truyền vào, `valueFrom` khác là giá trị giữ chỗ; (iii) nếu `enableServiceLinks !== false`: biến của mọi
  Service cùng `metadata.namespace` có ClusterIP (bỏ `clusterIP: None` và `type: ExternalName`) lấp khoá chưa có;
  (iv) biến của Service `kubernetes` (cổng 443, tên `https`) lấp khoá chưa có **bất kể cờ**. Tên biến:
  `<TÊN>_SERVICE_HOST`, `<TÊN>_SERVICE_PORT` (= `ports[0].port`), `<TÊN>_SERVICE_PORT_<TÊN CỔNG>` cho cổng có tên,
  `<TÊN>_PORT` (= `<proto thường>://<ip>:<ports[0].port>`), và với mỗi cổng `<TÊN>_PORT_<số cổng>_<PROTO>` cùng
  `_PROTO`, `_PORT`, `_ADDR` — TÊN = chữ hoa, `-` thành `_`, áp cho cả tên Service lẫn tên cổng; IP giữ chỗ. Thêm
  `enableServiceLinks?: boolean` vào `PodTemplate`.
- **Ở đâu:** `deploy/tests/kustomize.ts`; `deploy/tests/vm.test.ts` (dùng bản chung, bỏ bản riêng);
  `deploy/tests/manifests.test.ts` (ô "cấu hình trong cụm" đổi sang `effectiveEnv` cho từng service của `UDP_SERVICES`).
- **Hệ quả:** trên manifest hiện tại cả hai overlay **đỏ** đúng bốn khoá `CORE_BACKEND_PORT`, `FLAG_SERVICE_PORT`,
  `PD_CONTROLLER_PORT`, `PORTAL_PORT`. Một ô mới: với cờ `false`, mô hình VẪN có `KUBERNETES_SERVICE_HOST`.
- **Ai dùng hôm nay:** ô env schema của `manifests.test.ts` và `vm.test.ts`.

### 63c-2. `enableServiceLinks: false` ở chín pod template, cộng ô cấu trúc

- **Làm gì:** thêm `enableServiceLinks: false` vào pod spec của `k8s/base/{core-backend,flag-service,pd-controller,
  portal,prometheus}.yaml`, `postgres.yaml`, `migrate-job.yaml`, `k8s/overlays/kind/sample-app.yaml`,
  `k8s/overlays/vm/backup.yaml` (ở `jobTemplate.spec.template.spec`); chú thích đầy đủ ở `core-backend.yaml`, các tệp
  khác một dòng trỏ về đó. Ô cấu trúc ở cả hai tệp test: mọi `[...workloads(docs), ...byKind(docs, "CronJob")]` mang
  cờ; đếm đúng (kind: 8 — năm Deployment của base, `sample-app`, StatefulSet, Job; vm: 8 — năm Deployment,
  StatefulSet, Job, CronJob); không kind nào khác có `spec.template` hay `spec.jobTemplate` (QA C-10).
- **Hệ quả:** pod chỉ nhận env của chính nó cộng biến của Service `kubernetes`; `platform-probe.ts` không đổi.
  `install.ts:237` đã xoá Job `udp-migrate` cũ trước khi apply ⇒ đổi template Job không vướng "field is immutable".
- **Ai dùng hôm nay:** job `kind`, `vm`; hai bộ test.

**Kiểm 63c:** `pnpm --filter @udp/deploy test` — đỏ đúng bốn khoá sau 63c-1, xanh sau 63c-2.

---

## 63d — Job `test`, I35, nhãn runner, concurrency (QĐ-2, QĐ-3, QĐ-6, QĐ-8)

### 63d-1. Hai phép kiểm đọc lịch sử nói ra khi clone nông

- **Làm gì:** thêm ô ĐẦU vào khối thứ tự của `packages/adapter-core/tests/fixture-constants.test.ts` và khối "oracle
  độc lập" của `packages/design-lint/tests/oracle-independence.test.ts`: `git rev-parse --is-shallow-repository` là
  `false`, thông điệp "clone nông: mọi tệp trông như được thêm ở cùng một commit — CI phải `fetch-depth: 0`".
- **Hệ quả:** số ô `fixture-constants` 14 → 15, `oracle-independence` +1 (ghi vào báo cáo — đếm số ô là một phần sổ
  thi hành từ Plan #19).
- **Ai dùng hôm nay:** job `test`.

### 63d-2. `ci.yml`

- **Làm gì:** (a) job `test`: checkout `with: fetch-depth: 0` kèm chú thích; `timeout-minutes` của bước
  `test:scratch` 40 → 90, chú thích ghi căn cứ đo (21,5 phút trước `core-backend` ở run `37154337078`;
  `core-backend` 2283 s ở máy 04/10; CI/máy 1,10 ⇒ ~64 phút; ×1,4). (b) Concurrency cấp workflow:
  `group: ${{ github.workflow }}-${{ github.event_name }}-${{ github.ref }}`,
  `cancel-in-progress: ${{ github.event_name == 'pull_request' }}`, chú thích vì sao (QĐ-8).
  (c) `runs-on`: `ubuntu-24.04` cho mọi job trừ `build-smoke`, `signing-e2e` (giữ `ubuntu-latest` — nhãn của pipeline
  khách), chú thích một lần ở đầu `jobs`.
- **Ở đâu:** `.github/workflows/ci.yml`.

### 63d-3. Bốn workflow còn lại: `runs-on: ubuntu-24.04`

- **Ở đâu:** `.github/workflows/{deploy,publish,publish-rehearsal,toolchain}.yml` (1 + 5 + 1 + 2 job).

### 63d-4. Hằng nhãn runner của pipeline khách

- **Làm gì:** `export const GITHUB_ACTIONS_RUNNER = "ubuntu-latest"` trong `packages/config/src/build-toolchain.ts`,
  JSDoc nói nó là nhãn của pipeline SINH CHO KHÁCH và hai job diễn tập đọc cùng nguồn; `github-actions/index.ts` dùng
  nó ở hai chỗ (`runs-on: ${GITHUB_ACTIONS_RUNNER}`) — đầu ra giữ nguyên từng byte (hai wire fixture không đổi).
- **Ở đâu:** `packages/config/src/build-toolchain.ts`,
  `services/core-backend/src/modules/cicd-adapter/github-actions/index.ts`.
- **Ai dùng hôm nay:** `github-actions/index.ts`; cổng 63d-5.

### 63d-5. Cổng của `ci-workflow.test.ts`

- **Làm gì:** kiểu `Job`/`Step` thêm `"runs-on"`, `"timeout-minutes"`, `with`; bốn ô mới: (1) job `test`: checkout
  `fetch-depth: 0`, bước `test:scratch` có `timeout-minutes` ≥ 90; (2) đọc thư mục `.github/workflows/` (≥ 5 tệp): mọi
  job có `runs-on`; `build-smoke`, `signing-e2e` bằng `GITHUB_ACTIONS_RUNNER` (import `@udp/config/build-toolchain`);
  mọi job khác không kết thúc bằng `-latest`; (3) concurrency cấp workflow: group chứa `github.event_name`,
  `cancel-in-progress` là biểu thức chỉ đúng với `pull_request`; (4) script gốc `deploy:up` trỏ `kind-up`.
- **Ở đâu:** `deploy/tests/ci-workflow.test.ts`.

**Kiểm 63d:** `pnpm --filter @udp/deploy test`; `fixture-constants` 15 ô, `oracle-independence` xanh ở máy; bản clone
`--depth 1` ở scratchpad: `git rev-parse --is-shallow-repository` ⇒ `true` (ô đỏ đúng chỗ); `github-actions` test của
`core-backend` (khi RAM cho phép) hay khẳng định hai wire fixture không đổi bằng `git diff --exit-code`.

---

## 63e — README nói đúng về repo (QĐ-7, AC-6)

- **Làm gì:** "Yêu cầu": `Node.js ≥ 22.22.2`, `pnpm 9.12.0` (`packageManager`; `corepack enable`), Docker chỉ cho
  `dev:infra`/`deploy:up`. Cây thư mục: thêm `adapter-core`, `cloud-adapters`, `cluster-access`, `golden-path`,
  `sdks/python/`, `deploy/`, `docs/ban-giao/`, `docs/plans/`. Cổng `readme.test.ts`: khối mã đầu tiên mở bằng `udp/`
  có một dòng cây `<thư mục>/` cho mọi package của workspace, cho `sdks/` và `python/`; phần "Yêu cầu" chứa đúng
  `Node.js ≥ <engines.node>` và `pnpm <packageManager>`.
- **Ở đâu:** `README.md`, `packages/design-lint/tests/readme.test.ts`.
- **Ai dùng hôm nay:** người đọc README; job `test`.

**Kiểm 63e:** cổng đỏ trước khi sửa README (bảy mục cây + Node + pnpm), xanh sau.

---

## 63f — Tài liệu (AC-8)

- `docs/UDP_design.md`:
  - §3.1 cây `packages/`: thêm `config/`, `adapter-core/`, `cloud-adapters/`, `golden-path/`, `design-lint/`; dòng
    `http/` ghi hai subpath thuần [v4.12, Plan #63] (QA A4, G3).
  - §13.5: ghi chú **[v4.12, Plan #63, D-P55]** — lượt CI đầu, bốn gốc, cổng của từng loại; thay số "5 phút 20 giây"
    bằng số đo/ước mới; hệ quả của độ dài lên `Deploy` và cổng phát hành, và QĐ-8 (QA A6).
  - §15.1: ghi chú [v4.12, Plan #63, D-P55] ngay sau câu "cấu hình mà service từ chối là test đỏ, không phải pod crash"
    — câu đó sai tới Plan #63 vì mô hình thiếu lớp kubelet (QA A1).
  - §16: dòng "[v4.11, Plan #50] Dựng cụm…" thêm kết quả lượt đầu, trỏ `Sổ nợ: \`ci-github-green\``; dòng mới
    "[v4.12, Plan #63] Một chỗ chờ cho job `test`" (lượt chờ bị thay; gỡ bằng chạy lại).
  - Bảng quyết định: hàng **D-P55** sau D-P54, cột mục: §3.1, §13.3 (I35), §13.5, §15.1, §16, D-P37 (QA G6).
- `docs/measurements/kiem-chung-con-no.md`: mục `ci-github-green`, runbook HAI pha (QA A8): pha 1 trên PR (bảy job
  của PR, đo thời lượng thật của `test:scratch`); pha 2 sau merge (`build-smoke` sáu app, `Deploy`, `toolchain.yml`
  chạy tay, `publish-rehearsal.yml` chạy tay — `workflow_dispatch` chỉ có khi tệp nằm trên nhánh mặc định); lưu ý
  race của kubelet (QA C-11): một lượt `kind` xanh trước bản sửa không phải bằng chứng phủ định. "Số mục hiện tại: 53".
- `docs/ban-giao/trang-thai-2026-10-09.md`.

**Kiểm 63f:** `debt-ledger.test.ts`, `references.test.ts` của `design-lint`.

---

## Kiểm cuối (R9) và kiểm thoái cấp (R11)

1. `pnpm --filter @udp/deploy test`; các tệp `design-lint` đã chạm (`ci-entry-purity`, `script-names`, `readme`,
   `package-boundaries`, `oracle-independence`, `references`, `debt-ledger`); `fixture-constants`; typecheck của
   `@udp/http`, `@udp/deploy`, `@udp/design-lint`, `@udp/adapter-core`, `@udp/config`, `@udp/core-backend` (đo RAM
   trước; thiếu thì nói rõ và để job `check` của CI); eslint + prettier trên đúng tệp đã đổi.
2. R11, với mỗi chỗ sửa hỏi vì sao nó từng như thế: `@udp/config` gốc trong `build-script.ts` (tiện, chưa ai chạy nó
   ngoài service tới khi có CI); `up` (đối xứng `down`, máy dev không chạy được Docker nên chưa ai gõ); `effectiveEnv`
   (đúng với ConfigMap, thiếu lớp kubelet); `ubuntu-latest` (mặc định của mọi ví dụ GitHub); trần 40 phút và
   `cancel-in-progress: true` (đặt khi cả job chạy 5 phút).

---

## Ba agent QA đã bẻ gì (một vòng; hai lần bị ngắt bởi giới hạn phiên, làm tiếp từ chỗ dừng)

- **CHẶN — bản nháp dò tên trong thư mục rỗng chạy chương trình của PATH** (QA C-1..C-3): tên không phải lệnh có sẵn
  rơi về `exec`; cmd.exe chạy `node --help`, `git --help` — và với script `format` của gốc, `format.com`. Phép dò của
  chính tôi lúc khảo sát đã chạy `format --help` một lần (thoát khác 0, không gây hại). Thay bằng script đánh dấu.
- **CHẶN — entry bẩn thứ năm** (C-12): `references.test.ts` của cổng phát hành, qua `import()` literal.
- **CHẶN — §15.1/D-P37 khẳng định đúng điều G4 bác** (A1).
- **CHẶN — regex đọc workflow gán `sdk-version.ts`, `pack.ts` cho `core-backend`** (B1, C-13).
- **Nên sửa, đã nhận:** `absWorkingDir` (B2); chặn ở `onLoad` để không cần client Prisma (B3); ba tệp test của
  `gate` vào danh sách (B4); I35 trên clone nông (A2); tách phép dò khỏi tệp "đọc tệp" của cổng phát hành (A3);
  §3.1 (A4, G3); `import()` không literal là điểm mù (A5, C-14); concurrency (A6); nhãn pipeline khách (A7); runbook hai
  pha (A8); biến của Service `kubernetes`, `valueFrom`, CronJob và phép đếm workload (C-7..C-10); cấm cả
  `db/src/generated/` (C-15); plugin fail-closed với specifier lạ (C-16).
- **Ghi chú, xử lý bằng câu chữ:** lý do bác container ở QĐ-3 nói quá (G1); arm64, Golden Path ngoài phạm vi có lý do
  (G2, G5); tiền lệ 61d-3c (G4); `portal-demo` ngoài danh sách có lý do (C-17); race của kubelet (C-11).
- **Đã tự kiểm thay QA-C (phần agent chưa kịp làm):** `fetch-depth: 0` trên sự kiện `pull_request` — `git log
  --diff-filter=A` không có `-m` bỏ qua diff của commit merge, nên vẫn trả commit của nhánh; job `i28` dựa đúng điều
  này và đã xanh trên chính PR đó. Nhãn `ubuntu-24.04` là nhãn chuẩn của runner GitHub.
