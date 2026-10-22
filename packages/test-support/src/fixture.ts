import { createHash, randomUUID } from "node:crypto";
import { ACTOR_HEADER, env, INTERNAL_SECRET_HEADER } from "@udp/config";
import { issueSdkKeyToken, sdkKeyMaterialOf, type PrismaClient } from "@udp/db";
import request from "supertest";

/**
 * Fixture dùng chung cho test của Service 2 (app trong tiến trình) và của provider
 * (Service 2 là tiến trình con) [v4.7: chuyển từ `services/flag-service/tests`].
 */

/** Đích của lời gọi: app Express trong tiến trình HOẶC `baseUrl` của tiến trình con */
export type HttpTarget = Parameters<typeof request>[0];

/**
 * Chủ của project fixture — user CŨ NHẤT, không phải "một user bất kỳ".
 *
 * `findFirst` không `orderBy` trả hàng theo thứ tự vật lý mà Postgres đang giữ,
 * và thứ tự đó không được bảo đảm. `pnpm -r test` chạy core-backend SONG SONG
 * với flag-service trên cùng một database, và core-backend tạo user tạm rồi dọn
 * chúng cùng mọi thứ gắn với chúng khi xong. Nhặt nhầm đúng user tạm ấy làm chủ
 * thì project fixture của file này biến mất giữa chừng — đã thấy đúng hình dạng
 * đó: 65/65 test xanh, rồi `afterAll` nhận `P2025` vì project không còn để xoá.
 *
 * User cũ nhất là user của seed: được tạo trước mọi test, và không test nào
 * dọn nó. `findFirstOrThrow` thì ném rõ ràng nếu database chưa có user nào —
 * tức là seed chưa chạy — thay vì để test hỏng ở một chỗ khó hiểu hơn.
 */
export function stableOwner(admin: PrismaClient): Promise<{ id: string }> {
  return admin.user.findFirstOrThrow({
    select: { id: true },
    orderBy: { createdAt: "asc" },
  });
}

/** Một lời gọi `/internal/*` đã gắn bí mật và người làm */
export const internalCall = (
  req: request.Test,
  actorId: string,
): request.Test =>
  req
    .set(INTERNAL_SECRET_HEADER, env.INTERNAL_SERVICE_SECRET)
    .set(ACTOR_HEADER, actorId);

/**
 * [v4.6] Tạo flag qua route THẬT rồi KÍCH HOẠT nó (DRAFT → ACTIVE, cũng qua route).
 *
 * Flag DRAFT không vào snapshot (§6.7: SDK chưa nhận), nên mọi test đọc snapshot,
 * delta hay `/sdk/config` về một flag phải dùng flag đã kích hoạt — tạo xong đọc
 * ngay là đọc một flag không có mặt. Kích hoạt qua route (không UPDATE bằng owner)
 * để lần đổi đi đúng ADR-05: có version, có outbox, hash khớp.
 *
 * Trả response của lần kích hoạt: `body.flag` cùng hình với response tạo.
 */
export async function createActiveFlag(
  target: HttpTarget,
  actorId: string,
  body: Record<string, unknown>,
): Promise<request.Response> {
  const created = await internalCall(
    request(target).post("/internal/flags"),
    actorId,
  )
    .send(body)
    .expect(201);
  return internalCall(
    request(target).patch(`/internal/flags/${created.body.flag.id as string}`),
    actorId,
  )
    .send({
      lastKnownUpdatedAt: created.body.flag.updatedAt as string,
      lifecycleStatus: "ACTIVE",
    })
    .expect(200);
}

export const sha256 = (value: string): string =>
  createHash("sha256").update(value).digest("hex");

export type SdkKeyType = "SERVER" | "CLIENT";

/** Token thô sinh bằng CHÍNH hàm phát hành của S1 (`udp_sk_test_…` / `udp_ck_test_…`) */
export const newSdkKeyToken = (keyType: SdkKeyType): string =>
  issueSdkKeyToken(keyType, "test");

export interface SdkKeySpec {
  token: string;
  environmentId: string;
  keyType: SdkKeyType;
  createdById: string;
  label?: string;
  /** Khoá đã thu hồi từ đầu — ca 401 */
  revokedAt?: Date;
}

/**
 * Hàng `sdk_keys` cho một token thô — database chỉ giữ hash và đuôi, tính bằng
 * CÙNG `sdkKeyMaterialOf` mà S1 phát hành và guard của S2 tra. Dùng với
 * `createMany` khi test cần nhiều khoá cố định (khác env, khác loại, đã thu hồi).
 */
export function sdkKeyData(spec: SdkKeySpec) {
  return {
    environmentId: spec.environmentId,
    keyType: spec.keyType,
    ...sdkKeyMaterialOf(spec.token),
    label: spec.label ?? "test",
    createdById: spec.createdById,
    ...(spec.revokedAt === undefined ? {} : { revokedAt: spec.revokedAt }),
  };
}

/** Phát hành MỘT SDK key mới cho environment — trả token thô */
export async function issueSdkKey(
  admin: PrismaClient,
  options: Omit<SdkKeySpec, "token">,
): Promise<string> {
  const token = newSdkKeyToken(options.keyType);
  await admin.sdkKey.create({ data: sdkKeyData({ ...options, token }) });
  return token;
}

/** [v4.9] Một hàng `flag_evaluation_stats` dựng sẵn cho test */
export interface EvalStatSeed {
  flagId: string;
  environmentId: string;
  variantKey: string;
  evalCount: number;
  /** Phải là mốc ĐẦU GIỜ UTC (`hourFloor`) — khoá bucket của bảng */
  bucketHour: Date;
}

/**
 * [v4.9] Chèn thẳng số đếm đánh giá bằng owner, không đi qua bộ gộp.
 *
 * Test của chốt archive 7 ngày, của Cleanup Center và của stats theo flag cần
 * lịch sử 7/14/30 ngày. Dựng nó bằng đường thật thì phải giả cả đồng hồ của
 * Service 2 cho mỗi giờ trong cửa sổ; dựng thẳng ở đây cho cùng dữ liệu mà tất
 * định. Bảng KHÔNG có default cho `id` ở database, nhưng `createMany` của Prisma
 * áp `@default(uuid())` của schema nên không cần truyền.
 */
export async function seedEvalStats(
  admin: PrismaClient,
  rows: readonly EvalStatSeed[],
): Promise<void> {
  if (rows.length === 0) return;
  await admin.flagEvaluationStat.createMany({
    data: rows.map((row) => ({
      flagId: row.flagId,
      environmentId: row.environmentId,
      variantKey: row.variantKey,
      evalCount: BigInt(row.evalCount),
      bucketHour: row.bucketHour,
    })),
  });
}

/**
 * [v4.9] Lùi mốc thời gian của một flag bằng owner — cho ca STALE_DRAFT (flag
 * DRAFT quá 30 ngày) và ca "đã ACTIVE từ lâu".
 *
 * `activated_at` do trigger đặt, nên đây là cách DUY NHẤT để test có một flag đã
 * kích hoạt từ nhiều ngày trước. Ghi được vì trigger chỉ đặt mốc khi hàng CHUYỂN
 * sang ACTIVE (`OLD.lifecycle_status IS DISTINCT FROM 'ACTIVE'`): một flag đang
 * ACTIVE được sửa mốc thì trigger không chạm tới, và CHECK vẫn thoả vì mốc khác
 * null. Owner UPDATE được `feature_flags` (đã kiểm: R7-8).
 */
export async function backdateFlag(
  admin: PrismaClient,
  flagId: string,
  when: { createdAt?: Date; activatedAt?: Date },
): Promise<void> {
  await admin.featureFlag.update({
    where: { id: flagId },
    data: {
      ...(when.createdAt === undefined ? {} : { createdAt: when.createdAt }),
      ...(when.activatedAt === undefined
        ? {}
        : { activatedAt: when.activatedAt }),
    },
  });
}

/**
 * [v4.9] Rào chắn khoá hàng `environments` — công cụ làm test ĐUA tất định.
 *
 * Mọi lần ghi cấu hình bắt đầu bằng bước 1 của ADR-05 (`UPDATE environments …`),
 * nên hàng `environments` là điểm tuần tự hoá duy nhất của cả hệ. Giữ `FOR UPDATE`
 * trên chính những hàng đó rồi bắn hai request vào biến "hai thứ này có tuần tự
 * hoá không" từ chuyện may rủi lịch OS thành chuyện xác định: cả hai đứng ở hàng
 * đợi khoá của Postgres theo thứ tự đến, và `release()` cho chúng chạy.
 *
 * `pid` là backend đang giữ khoá — `waitForBlocked` đếm ai bị CHÍNH nó chặn, chứ
 * không đếm mọi backend đang chờ: `pnpm -r test` chạy nhiều gói song song trên
 * cùng một database, và một con số toàn cục sẽ nhận nhầm người chờ của file khác.
 */
export interface EnvRowGate {
  pid: number;
  /** Nhả khoá và chờ transaction giữ khoá kết thúc — gọi trong `finally` */
  release(): Promise<void>;
}

/** Hạn của transaction giữ khoá: dài hơn mọi lần chờ mà test hợp lệ cần */
const GATE_TIMEOUT_MS = 30_000;

export async function lockEnvRows(
  admin: PrismaClient,
  environmentIds: readonly string[],
): Promise<EnvRowGate> {
  const ids = [...environmentIds].sort();
  let open!: () => void;
  const gate = new Promise<void>((resolve) => {
    open = resolve;
  });
  let acquire!: (pid: number) => void;
  let fail!: (err: unknown) => void;
  const acquired = new Promise<number>((resolve, reject) => {
    acquire = resolve;
    fail = reject;
  });

  const held = admin.$transaction(
    async (tx) => {
      /**
       * `ORDER BY id … FOR UPDATE` theo đúng thứ tự mà `writeWithOutbox` khoá,
       * nên rào chắn không bao giờ là bên gây deadlock.
       */
      const rows = await tx.$queryRaw<{ pid: number }[]>`
        SELECT pg_backend_pid()::int AS pid
          FROM environments
         WHERE id = ANY(${ids}::text[]::uuid[])
         ORDER BY id
           FOR UPDATE`;
      const pid = rows[0]?.pid;
      if (rows.length !== ids.length || pid === undefined) {
        throw new Error(
          `lockEnvRows: khoá được ${String(rows.length)}/${String(ids.length)} hàng environments`,
        );
      }
      acquire(pid);
      await gate;
    },
    { maxWait: 10_000, timeout: GATE_TIMEOUT_MS },
  );
  const settled = held.catch((err: unknown) => {
    fail(err);
  });

  return {
    pid: await acquired,
    release: async () => {
      open();
      await settled;
    },
  };
}

/**
 * [v4.9] Chờ tới khi có ít nhất `expected` backend xếp hàng sau rào chắn.
 *
 * `pg_blocking_pids` chứ không `pg_locks` thô: một bên chờ khoá HÀNG xếp hàng
 * qua hai loại khoá (`tuple` rồi `transactionid`), nên đếm "lock chưa được cấp
 * trên bảng environments" trả 0 và test hết hạn chờ dù mọi thứ đúng.
 *
 * Và phải đếm cả CHUỖI chờ, không chỉ người bị rào chắn chặn TRỰC TIẾP: người
 * thứ hai vào hàng đợi bị chặn bởi người thứ NHẤT (kẻ đang giữ tuple lock trong
 * lúc chính nó chờ rào chắn), nên `pg_blocking_pids` của nó trả pid người thứ
 * nhất chứ không trả pid rào chắn. Đếm trực tiếp thì con số đứng mãi ở 1 — đã đo.
 *
 * Gốc là `gate.pid`, không phải "mọi backend đang chờ": `pnpm -r test` chạy nhiều
 * gói song song trên cùng một database, và một con số toàn cục sẽ nhận nhầm
 * người chờ của file khác.
 *
 * Không `sleep` một khoảng cố định: 50 ms đủ trên máy rảnh và không đủ khi máy
 * đang tải, mà một con số như vậy làm test xanh/đỏ theo tốc độ máy.
 */
export async function waitForBlocked(
  admin: PrismaClient,
  gate: EnvRowGate,
  expected: number,
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const rows = await admin.$queryRaw<{ n: number }[]>`
      WITH RECURSIVE waiters(pid) AS (
        SELECT a.pid
          FROM pg_stat_activity a
         WHERE ${gate.pid}::int = ANY(pg_blocking_pids(a.pid))
        UNION
        SELECT a.pid
          FROM pg_stat_activity a, waiters w
         WHERE w.pid = ANY(pg_blocking_pids(a.pid))
      )
      SELECT count(*)::int AS n FROM waiters`;
    if ((rows[0]?.n ?? 0) >= expected) return;
    if (Date.now() > deadline) {
      throw new Error(
        `waitForBlocked: sau ${String(timeoutMs)} ms vẫn chưa có ${String(expected)} backend xếp hàng sau rào chắn`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/** Một bảng có ít nhất một hàng khớp mẫu — danh sách rỗng là điều phải thấy */
export interface SecretHit {
  table: string;
  rows: number;
}

/**
 * [v4.9] Quét TOÀN BỘ database tìm một chuỗi — INV-23.3.
 *
 * Bất biến nói "plaintext SDK key không nằm trong database", và cách duy nhất
 * kiểm đúng câu đó là quét mọi bảng, không phải bốn bảng đã nghĩ ra trước. R04 kể
 * bốn chỗ nghi nhất (`audit_logs`, `idempotency_keys`, `config_change_log`,
 * `sdk_keys`), nhưng chỗ gây rò rỉ thật bao giờ cũng là chỗ chưa ai nghĩ tới —
 * một cột `last_error`, một payload job, một bảng thêm sau này. Danh sách bảng
 * vì thế đọc từ `information_schema` lúc chạy.
 *
 * `row_to_json(t.*)::text` chứ không liệt kê cột kiểu text: nó phủ luôn `jsonb`
 * lồng sâu, `varchar`, `char`, mảng, và cả cột thêm vào ngày mai mà không ai sửa
 * hàm này. Cái giá là một lần tuần tự hoá mỗi hàng — chấp nhận được trên database
 * test, và đây là phép kiểm an ninh, không phải đường nóng.
 *
 * `pattern` là biểu thức chính quy POSIX (toán tử `~`), không phải `LIKE`: nhờ
 * vậy cùng một hàm kiểm được cả một token CỤ THỂ (token chỉ gồm `[a-z0-9_]`, nên
 * nó là regex của chính nó) và MẪU chung của mọi token
 * (`SDK_KEY_PLAINTEXT_PATTERN`) — thứ bắt được cả khoá do một test khác làm rò.
 *
 * Chỉ `BASE TABLE` của schema `public`: view và materialized view đọc lại chính
 * các bảng này, nên quét chúng là đếm hai lần cùng một hàng.
 */
export async function scanForSecret(
  admin: PrismaClient,
  pattern: string,
): Promise<SecretHit[]> {
  const tables = await admin.$queryRaw<{ name: string }[]>`
    SELECT table_name AS name
      FROM information_schema.tables
     WHERE table_schema = 'public'
       AND table_type = 'BASE TABLE'
     ORDER BY table_name`;

  const hits: SecretHit[] = [];
  for (const { name } of tables) {
    /**
     * Tên bảng vào câu lệnh qua `quote_ident` của một truy vấn tham số hoá được
     * thì tốt hơn, nhưng Postgres không cho tham số hoá tên bảng. Nguồn của
     * `name` là `information_schema` của chính database này, và mẫu `^[a-z0-9_]+$`
     * là chốt để một tên bảng lạ không bao giờ thành SQL — không phải vì ai đó
     * tấn công test, mà để lỗi nổ rõ ràng nếu schema có tên cần trích dẫn.
     */
    if (!/^[a-z0-9_]+$/.test(name)) {
      throw new Error(`scanForSecret: tên bảng không quét được: ${name}`);
    }
    const rows = await admin.$queryRawUnsafe<{ n: number }[]>(
      `SELECT count(*)::int AS n FROM "${name}" t WHERE row_to_json(t.*)::text ~ $1`,
      pattern,
    );
    const n = rows[0]?.n ?? 0;
    if (n > 0) hits.push({ table: name, rows: n });
  }
  return hits;
}

export interface ScratchProject {
  projectId: string;
  environmentId: string;
  ownerId: string;
  /** Xoá project cùng outbox và audit của nó — gọi trong `finally` */
  dispose(): Promise<void>;
}

/**
 * Xoá một project dùng một lần cùng dấu vết của nó [v4.8]: `config_change_log`
 * (outbox — không CASCADE theo project) và `audit_logs`, rồi project (CASCADE
 * environment, flag, SDK key).
 */
export async function disposeProject(
  admin: PrismaClient,
  projectId: string,
): Promise<void> {
  const environments = await admin.environment.findMany({
    where: { projectId },
    select: { id: true },
  });
  await admin.configChangeLog.deleteMany({
    where: { environmentId: { in: environments.map((e) => e.id) } },
  });
  await admin.auditLog.deleteMany({ where: { projectId } });
  await admin.project.deleteMany({ where: { id: projectId } });
}

/**
 * Project dùng một lần với MỘT environment `dev` — cho test tích hợp và phép đo
 * (`@udp/experiments`). Tên mang tiền tố để dữ liệu sót lại (tiến trình bị giết giữa
 * chừng) nhận ra và dọn được bằng tiền tố.
 */
export async function createScratchProject(
  admin: PrismaClient,
  prefix: string,
): Promise<ScratchProject> {
  const owner = await stableOwner(admin);
  const suffix = randomUUID().slice(0, 8);
  const project = await admin.project.create({
    data: {
      ownerId: owner.id,
      name: `${prefix}-${suffix}`,
      creationMode: "CREATE_NEW",
      languageRuntime: "nodejs",
      resourceQuota: {},
      environments: {
        create: [
          { name: "dev", rank: 0, k8sNamespace: `udp-${prefix}-${suffix}` },
        ],
      },
    },
    select: { id: true, environments: { select: { id: true } } },
  });
  const environmentId = project.environments[0]?.id;
  if (environmentId === undefined) throw new Error("project thiếu environment");
  return {
    projectId: project.id,
    environmentId,
    ownerId: owner.id,
    dispose: () => disposeProject(admin, project.id),
  };
}
