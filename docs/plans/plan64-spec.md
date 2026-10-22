# Plan #64 — Spec: sửa 4 lỗi CI lượt #46 (run `38879844829`)

Nối tiếp Plan #61/#62 (nhánh `p61-dong-goi`, PR `23521549-lang/udp#1`, tip `46d6ed6`).
CI lượt #46 (16/10/2026 09:21 UTC): **5 xanh / 4 đỏ / 1 skip** (`build-smoke` skip theo thiết kế).

| Job đỏ        | Bước đỏ                                        | Dòng lỗi (nguyên văn)                                                                                                     |
| ------------- | ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `signing-e2e` | image nhỏ ở hai registry                       | `Invalid source name ...: Docker references with both a tag and digest are currently not supported`                       |
| `kind`        | `pnpm deploy:up` → `kubectl wait` timeout 600s | `Error opening a TLS connection: The server does not support SSL connections` tại `seedDomainCatalog` (job `udp-migrate`) |
| `vm`          | `release.sh` → `rollout status` timeout 300s   | Cùng lỗi TLS tại `assertConnectedAs` của cả 3 service (CrashLoopBackOff)                                                  |
| `test`        | `pnpm test:scratch`                            | `FAIL tests/integration.test.ts > fail-static > I34` — `flagMetadata: {}` thiếu `stale: true`                             |

Spec này đã qua 3 vòng QA bẻ (correctness, security, clean-code) ngày 16/10/2026; mọi phát hiện
blocker/major đã được hấp thụ (ghi chú `[QA]`).

## 1. Bốn gốc lỗi — mỗi cái có minh chứng

**G1 — `BASE` vừa tag vừa digest, skopeo từ chối** (`.github/workflows/ci.yml:329`).
Minh chứng: dòng `level=fatal` trong log CI; digest `bdf57e…` đã đối chiếu trực tiếp với Docker Hub
(`docker-content-digest` của tag `1.37.0`, Accept OCI index, 16/10/2026) và chạy thử
`skopeo copy --format oci --override-arch amd64/arm64 docker://busybox@sha256:bdf57e…` thành công
cả hai arch (skopeo 1.24.1). Digest-only là pin bất biến — mạnh hơn tag.

**G2 — ba đường mở kết nối ép TLS verify-full, postgres kèm cụm không có SSL.**
Minh chứng: `packages/db/src/adapter.ts` (`ssl: DB_TLS_OPTIONS`),
`packages/db/src/session.ts:67` (`new Client({ ..., ssl: DB_TLS_OPTIONS })`),
`services/core-backend/src/jobs/boss.ts:126` (`new PgBoss({ ..., ssl: DB_TLS_OPTIONS })`);
`deploy/k8s/base/postgres.yaml` dùng `postgres:16-alpine` không một dòng cấu hình SSL;
log kind (seed) và vm (3 service) cùng lỗi TLS. `[QA1-blocker]` Chỉ sửa `createPgAdapter`
là chưa đủ: core-backend sẽ qua `assertConnectedAs` rồi CrashLoopBackOff tại `boss.start()`,
kênh LISTEN của S2/S3 rơi vào `unreachable` — CI vẫn đỏ.

**G3 — catch-all dán nhãn sai, che nguyên nhân thật.** Đúng 3 chỗ
(`services/core-backend/src/index.ts:45`, `services/flag-service/src/index.ts:29`,
`services/pd-controller/src/index.ts:30`): mọi lỗi từ `assertServiceIdentity()` (kể cả lỗi TLS
P1011) đều bị log thành "Không khởi động: danh tính kết nối database sai".
`[QA1-major/QA3-blocker]` Hai site LISTEN (`flag-service/src/index.ts:50`,
`pd-controller/src/index.ts:126`) NGOÀI PHẠM VI: chúng rẽ nhánh trên `IdentityVerdict`
của `verifyIdentity()` (`wrong-role`/`unreachable`) — phân loại đã đúng, không có `err` trong scope.

**G4 — test I34 flaky: flap STALE→READY trong lúc Service 2 tắt êm.**
Minh chứng: FAIL log CI (dòng 551, `flagMetadata: {}`); `services/flag-service/src/index.ts:103-193`
graceful shutdown giữ HTTP phục vụ trên kết nối keep-alive đang mở (tối đa 10s);
`packages/openfeature-provider/src/sync.ts:394` (`fresh()`) là đường duy nhất reset `stale=false`;
test `waitFor` poll mỗi 5ms (`tests/helpers/wait.ts`) đọc mảng sự kiện chỉ-thêm — một poll muộn
thành công sau sự kiện "stale" lật cờ về false trước khi assertion đọc. Product hành xử đúng
(poll thành công ⇒ tươi); giả định của test ("thấy sự kiện stale ⇒ cờ giữ nguyên") sai trong lúc tắt êm.
82/82 unit test của package xanh khi chạy local (16/10/2026).
`[QA1-major]` Test revoke (`fail-static`, ~dòng 521-527) có cùng race (poll 200 về sau sự kiện
"error" ⇒ `unauthorized=false`) — sửa cùng cách.

## 2. Thiết kế fix

### 64a — signing-e2e (1 dòng + comment + cổng)

- `.github/workflows/ci.yml:329`:
  `BASE: busybox@sha256:bdf57e528e45e4433820e045b29b4597825a1c9e38353532d90a01445013f82e`
  kèm comment: digest-only vì skopeo từ chối ref vừa tag vừa digest (đối chiếu Docker Hub 16/10/2026;
  nếu Hub rebuild tag thì skopeo 404 ⇒ CI đỏ ồn ào, fail-closed).
- Cổng đỏ-trước (`deploy/tests/ci-workflow.test.ts`): giữ assertion dương hiện có
  (`/@sha256:[0-9a-f]{64}$/` — lưu ý nó đã xanh với giá trị lỗi, đó là lý do bug lọt),
  thêm assertion âm **đúng phạm vi `BASE`** (không quét mọi ref: image service `zot` ở
  `ci.yml:323` là tag+digest nhưng do runner pull, hợp lệ):
  `expect(e2e.env?.BASE).not.toMatch(/:[^/:@]+@sha256:/)`.
- Verify cuối: CI lượt tiếp theo.

### 64b — chế độ TLS tường minh (quyết định A của Han, 16/10/2026)

`[QA3-major]` Không đọc `process.env` thô trong `adapter.ts`: `packages/config/src/env.ts`
là nguồn sự thật duy nhất cho env (không file nào trong `packages/*/src` đọc thô).
Chế độ đi qua env-schema và tham số tường minh:

- `packages/config/src/env-schema.ts`: thêm
  `UDP_DB_TLS_MODE: z.enum(["verify-full", "disable"]).default("verify-full")`
  kèm doc comment (zod fail-fast với chuỗi rỗng/giá trị lạ — không đoán ý).
- `packages/db/src/adapter.ts`:
  - `export type TlsMode = "verify-full" | "disable"`.
  - `export function resolveTlsOptions(tlsMode: TlsMode, connectionString: string)` — hàm thuần:
    `"verify-full"` ⇒ `DB_TLS_OPTIONS`; `"disable"` ⇒ kiểm tra host rồi trả `undefined`.
    `[QA2-major]` **Rào host-binding (bắt buộc):** `disable` chỉ cho host nội bộ
    (`localhost`, `127.0.0.1`, `::1`, tên single-label như `postgres`, `*.svc`, `*.cluster.local`);
    host khác ⇒ ném fail-fast kèm hướng dẫn mở rộng allowlist. Ngăn `disable` lọt sang
    Supabase/cloud ⇒ credential đi plaintext câm lặng (kịch bản T2).
  - `createPgAdapter({ connectionString, max, ..., tlsMode = "verify-full" })`:
    dùng conditional spread `...(tlsOptions === undefined ? {} : { ssl: tlsOptions })`
    thay vì `ssl: undefined` tường minh (không phụ thuộc chi tiết `Object.assign` của `pg`).
    Cập nhật comment TLS (dòng ~65, 92, 98-104) cho đúng cơ chế mới.
  - Giữ nguyên `DB_TLS_OPTIONS` export (invariant `connection-string.test.ts:69`);
    `sanitizeConnectionString` giữ nguyên.
- `packages/db/src/session.ts`: `createSessionConnector(connectionString, tlsMode = "verify-full")`,
  luồn vào `sessionClient` → cùng conditional spread. Callers
  (`flag-service/src/changefeed/index.ts:84`, `pd-controller/src/index.ts:112`) truyền
  `env.UDP_DB_TLS_MODE` (cả hai đã import `@udp/config`).
- `services/core-backend/src/jobs/boss.ts`: `JobQueueOptions` thêm `tlsMode: TlsMode`;
  `new PgBoss({ connectionString: sanitized, ...spread(resolveTlsOptions(tlsMode, sanitized)), ... })`;
  `src/index.ts:71` truyền `tlsMode: env.UDP_DB_TLS_MODE`.
- `packages/db/src/index.ts` `createPrismaClient`: `PrismaClientOptions` thêm `tlsMode?: TlsMode`,
  truyền xuống `createPgAdapter`; các service truyền `env.UDP_DB_TLS_MODE`.
  `prisma/seed.ts` truyền `env.UDP_DB_TLS_MODE` (đã import `@udp/config`).
- `deploy/k8s/base/kustomization.yaml`: thêm `UDP_DB_TLS_MODE=disable` vào
  `configMapGenerator` literals (base luôn kèm postgres không TLS; kind+vm đều dùng base;
  4 manifest `envFrom: udp-config`).
- `.env.example`: document biến mới ("chỉ cho postgres kèm cụm/local không TLS;
  KHÔNG bao giờ đặt khi DATABASE_URL trỏ Supabase/cloud").
- Scripts (`service-login.ts`, `scratch-database.ts`) và test-helpers không chạy trong cụm ⇒
  giữ `DB_TLS_OPTIONS` cứng, không luồn tham số.
- Cổng đỏ-trước:
  - `packages/db/tests/adapter-tls.test.ts` (mới): `resolveTlsOptions("disable", <host nội bộ>)`
    ⇒ `undefined`; `("disable", "postgresql://u@db.xxx.supabase.co/x")` ⇒ ném;
    `("verify-full", _)` ⇒ đúng `DB_TLS_OPTIONS`.
  - Case env-schema của `@udp/config` (thêm vào file test hiện có; nếu chưa có thì tạo):
    thiếu/rỗng ⇒ lỗi validation; `"disable"` ⇒ `"disable"`.
  - `deploy/tests/manifests.test.ts`: ConfigMap sinh ra chứa `UDP_DB_TLS_MODE=disable`.

### 64c — phân loại lỗi boot bằng class riêng (3 site)

`[QA1-major]` Nhận diện tích cực phía danh tính thay vì liệt kê lớp lỗi kết nối
(`instanceof PrismaClientKnownRequestError` bỏ lọt `UnknownRequestError`, pool timeout…):

- `packages/db/src/identity.ts`: `export class DbIdentityMismatchError extends Error`;
  `assertConnectedAs` ném class này (giữ nguyên message — bị `boot-identity.test.ts` ghim
  qua `toContain("danh tính kết nối database sai")`, và `service-identity.test.ts` ghim nội dung).
- Cùng file: `export function describeBootFailure(err: unknown): string`:
  `err instanceof DbIdentityMismatchError ? "Không khởi động: danh tính kết nối database sai"
: "Không khởi động: không kết nối được database"`.
  Chuỗi message giữ nguyên từng chữ — spec ghi thành yêu cầu tường minh.
- Export cả hai qua `packages/db/src/index.ts`.
- 3 site (`core-backend/src/index.ts:45`, `flag-service/src/index.ts:29`,
  `pd-controller/src/index.ts:30`): `import { describeBootFailure } from "@udp/db"`;
  `logger.fatal({ err }, describeBootFailure(err))`. `{ err }` vẫn log như cũ.
- Cổng đỏ-trước: `packages/db/tests/boot-errors.test.ts` —
  `new DbIdentityMismatchError("…")` ⇒ chứa "danh tính kết nối database sai";
  `new Error("…")` và `new Prisma.PrismaClientKnownRequestError("…", { code: "P1011", clientVersion: "x" })`
  ⇒ chứa "không kết nối được database".

### 64d — hết flaky cho I34 và test revoke (sửa test, không sửa product)

- `packages/openfeature-provider/tests/integration.test.ts`: sau `waitFor` sự kiện
  ("stale" ở I34 ~dòng 550; "error" ở test revoke ~dòng 524), thêm:
  ```ts
  // Tắt êm: một poll muộn có thể thành công sau sự kiện, lật cờ về false
  // trước khi assertion đọc (flap hợp lệ của product). Tiến trình đã exit nên
  // không còn success nào nữa: đọc tới khi CHÍNH LÚC ĐỌC thấy stale=true.
  await waitFor(
    async () =>
      (await client.getBooleanDetails("i15-a", true)).flagMetadata["stale"] ===
      true,
    10_000,
  );
  ```
  rồi mới `expect(...).toMatchObject({ ... flagMetadata: { stale: true } })`.
- Vì sao không sửa product: hành vi hiện tại đúng hợp đồng STALE (`docs/UDP_design.md:4007-4024`);
  hysteresis sẽ làm chậm phục hồi cho mọi consumer.
- Vì sao `waitFor` này kết thúc chắc chắn: sau `s2.stop()` (tiến trình đã exit —
  `stopChild` chờ sự kiện `exit`, SIGKILL fallback 5s) không còn `fresh()` nào ⇒ `stale`
  đơn điệu; `checkStale` bật nó trong ~1,1s. Nếu provider thật sự không stale, timeout 10s ⇒ đỏ đúng.
  `waitFor` ném khi hết giờ nên không treo vô hạn.
- Cổng: chính hai test trên CI (cần DB thật, không chạy local được).
  "Đỏ" ban đầu của cổng này chính là log CI #46 — ghi rõ ngoại lệ so với lệ đỏ-trước.

## 3. Thứ tự thực hiện (trên nhánh mới)

1. Tạo nhánh mới từ `p61-dong-goi` (tên trung tính, vd `fix/plan-64-sua-4-loi-ci`).
2. Viết test/case mới (§2: adapter-tls, env-schema, boot-errors, ci-workflow, manifests) →
   chạy → **đỏ** (ghi log). Ngoại lệ: 64d — "đỏ" là log CI #46 đã có.
3. Code fix → chạy → **xanh**, kèm typecheck + lint + format của repo.
4. Commit spec này vào `docs/plans/plan64-spec.md` cùng nhánh (lệ từ `d14bf21`).
5. Commit: một hoặc vài commit, một dòng, tiếng Anh, conventional commits,
   đứng tên `23521549-lang <23521549@gm.uit.edu.vn>`, không Co-Authored-By, không attribution.
6. Push nhánh, đọc CI lượt tiếp theo. **Không merge PR #1.**

## 4. Ngoài phạm vi (không động)

- Merge PR #1 (chờ lệnh riêng, qua nhiều vòng review).
- Bug duplicate React key ở portal (`AdminOverviewPage.tsx` `RecentFailedJobs`) — ghi nhận riêng.
- 53 verification-debt cần cloud/cluster/RAM thật.

## 5. Quyết định kiến trúc (ghi nhận thay ADR)

**Ngữ cảnh:** postgres kèm cụm (`postgres:16-alpine`) không bật SSL; ba đường mở kết nối ép TLS
verify-full ⇒ kind/vm đỏ.
**Quyết định (Han chốt phương án A, 16/10/2026; QA2 chấp nhận có điều kiện):** chế độ TLS tường
minh qua `UDP_DB_TLS_MODE` trong env-schema (`verify-full` mặc định | `disable` cho cụm),
tham số tường minh qua mọi đường mở kết nối, rào host-binding fail-closed cho `disable`.
**Phương án B đã loại:** tự ký cert bật SSL cho postgres kèm cụm — thêm cả cụm quản lý cert,
phức tạp hơn lợi ích (traffic chỉ trong cụm).
**Vì sao không `PGSSLMODE`:** chuẩn libpq có 6 mức gồm `prefer`/`allow` (opportunistic, dễ
downgrade); allowlist 2 giá trị nghiêm hơn và mặc định an toàn.
**Hệ quả:** đường Supabase/cloud không đổi (verify-full + rào host); cụm kind/vm tắt TLS ở
tầng TCP trong cụm — đánh đổi có chủ ý, không phải lỗ hổng (threat model T2 viết cho
credential cloud; rào host-binding ngăn chính kịch bản T2 khi misconfigure).

## 6. Tiêu chí nghiệm thu

- CI lượt tiếp theo: 4 job đỏ → xanh; không job xanh nào đỏ theo.
- Mọi cổng clean-code của repo xanh (typecheck, lint, format, import boundaries, tests).
- Không TODO/FIXME, không nợ kỹ thuật mới.
