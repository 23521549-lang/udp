import { randomUUID } from "node:crypto";
import { CONDITION_LIMITS, SDK_KEY, SEGMENT, env } from "@udp/config";
import {
  createPrismaClient,
  issueSdkKeyToken,
  sdkKeyMaterialOf,
  SDK_KEY_PLAINTEXT_PATTERN,
} from "@udp/db";
import { FakeMetricsProvider } from "@udp/metrics-provider/testing";
import {
  scanForSecret,
  startFlagService,
  type RunningService,
} from "@udp/test-support";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { createFlagServiceClient } from "../src/core/clients/flag-service.client.js";
import {
  API,
  as,
  testWorld,
  type Actor,
  type ProjectEnv,
  type TestWorld,
} from "./helpers/api.js";
import { tapServiceLog, type LogTap } from "./helpers/log-tap.js";
import {
  inertCloudPlatform,
  noDomainAdapters,
  inertProvisioning,
} from "./helpers/inert-deps.js";

/**
 * Tài nguyên gắn theo project ở Service 1, với Service 2 là tiến trình THẬT
 * (§3.1) [v4.9].
 *
 * Một file cho nhiều loại tài nguyên (segment và SDK key) vì cái đắt nhất ở đây
 * không phải số ca mà là phần dựng: năm nhân vật là năm lần bcrypt 12 vòng, cộng
 * một lần khởi động Service 2. Chia thành hai file là trả giá đó hai lần cho cùng
 * một bộ nhân vật.
 *
 * Bốn nhóm câu hỏi:
 *
 *   - **Quyền** (L6, R08): mức tối thiểu của từng route, và mỗi ô bị từ chối phải
 *     KHÔNG gọi Service 2 lần nào.
 *   - **Sở hữu** (I14, R05): id của project khác ở mọi route ⇒ 404, S2 nhận 0
 *     lời gọi.
 *   - **Parser** (V14, V15, INV-23.8): thân 16 MiB chỉ được parse SAU xác thực và
 *     quyền, và đường dẫn khác hoa thường vẫn đi đúng parser lớn.
 *   - **Relay** (§9): lỗi nghiệp vụ của S2 tới Portal nguyên vẹn, và audit do S2
 *     ghi mang người đã đăng nhập chứ không phải header Portal tự khai.
 *
 * [v4.9] Với SDK key thêm ba nhóm nữa, mỗi nhóm là một chốt riêng của L7/R04:
 *
 *   - **Bí mật không rò (R04, INV-23.3):** plaintext chỉ hiện trong response TẠO,
 *     và không nằm ở bất kỳ bảng nào của database, trong log của Service 1 hay
 *     của Service 2, và không đi qua middleware idempotency.
 *   - **Thử lại (R24, V4, AC-5.5):** Service 2 commit rồi response mất ⇒ Service 1
 *     thử lại đúng một lần với cùng vật liệu, người dùng nhận 201 kèm plaintext,
 *     và database có ĐÚNG một hàng.
 *   - **Quyền OWNER (L7):** đọc VIEWER, tạo và thu hồi OWNER, và mỗi ô bị từ chối
 *     KHÔNG gọi Service 2 lần nào.
 */

const admin = createPrismaClient({
  connectionString: env.DATABASE_URL,
  max: 2,
  cacheKey: "__udp_prisma_project_resources_test",
});

let s2: RunningService | undefined;
let app: ReturnType<typeof createApp>;
let world: TestWorld;
let owner: Actor;
let maintainer: Actor;
let developer: Actor;
let viewer: Actor;
/** Không phải thành viên project nào — mọi route phải trả 404, không 403 */
let outsider: Actor;
let projectId: string;
let envs: Record<string, ProjectEnv>;
/** Project thứ hai của cùng owner — nguồn id "của project khác" */
let other: { projectId: string; envs: Record<string, ProjectEnv> };
/** Số lời gọi S1 → S2. Phép kiểm quyền và sở hữu phải chặn TRƯỚC khi gọi */
let s2Calls = 0;
/** [v4.9] Bật MỘT lần: lời gọi S2 kế tiếp commit xong rồi "mất" response (R24) */
let dropNextResponse = false;
/** [v4.9] Log của Service 1 trong tiến trình này — INV-23.3 quét nó */
let logTap: LogTap | undefined;

const segmentsUrl = (pid = projectId): string =>
  `${API}/projects/${pid}/segments`;

/** [v4.9] Khoá của env `dev` thuộc project chính */
const keysUrl = (): string =>
  `${API}/projects/${projectId}/environments/${envOf("dev").id}/keys`;

const named = (tag: string): string => `${tag}-${randomUUID().slice(0, 8)}`;

const oneUser = { all: [], userIds: ["u-1"] };

const userIds = (count: number, tag: string): string[] =>
  Array.from({ length: count }, (_, i) =>
    `${tag}-${String(i)}`.padEnd(CONDITION_LIMITS.userIdMaxLength, "x"),
  );

interface SegmentView {
  id: string;
  name: string;
  updatedAt: string;
  summary: {
    conditionCount: number;
    userIdCount: number;
    hasRegex: boolean;
    payloadBytes: number;
  };
  usage: { flagCount: number; productionFlagCount: number };
}

async function newSegment(
  actor: Actor = developer,
  pid = projectId,
  conditions: object = oneUser,
): Promise<SegmentView> {
  const res = await as(
    actor,
    request(app)
      .post(segmentsUrl(pid))
      .send({ name: named("seg"), conditions }),
  ).expect(201);
  return res.body.segment as SegmentView;
}

beforeAll(async () => {
  /**
   * [v4.9] `LOG_LEVEL: "info"` để INV-23.3 quét được log của Service 2.
   *
   * Mặc định của `startFlagService` là `warn`, và ở mức đó một lần tạo khoá thành
   * công không sinh dòng log nào — phép quét "không có plaintext trong log của
   * Service 2" khi ấy xanh vì không có gì để đọc, chứ không vì không có gì để
   * thấy. Ở `info` thì mỗi request có một dòng, và chính chúng phải sạch.
   */
  const started = await startFlagService({ env: { LOG_LEVEL: "info" } });
  s2 = started;
  logTap = tapServiceLog();
  app = createApp({
    metricsFor: () => new FakeMetricsProvider(),
    oidcIssuer: null,
    cloud: inertCloudPlatform,
    domainRegistry: noDomainAdapters,
    provisioning: inertProvisioning,
    flagService: createFlagServiceClient({
      baseUrl: started.baseUrl,
      secret: env.INTERNAL_SERVICE_SECRET,
      /**
       * [v4.9] `fetch` này dựng lại được MỘT hình dạng lỗi: "Service 2 đã commit,
       * response mất" (R24). Nó gửi request THẬT, đọc hết thân để Service 2 hoàn
       * tất, rồi ném đúng thứ `AbortSignal.timeout` ném. Cờ tự tắt sau một lần,
       * nên lần thử lại của client đi qua bình thường.
       *
       * Vì sao không chỉ ném mà không gửi: thứ R24 nói là Service 2 ĐÃ GHI mà
       * Service 1 không biết. Một `fetch` ném trước khi gửi chỉ dựng lại ca "chưa
       * ghi" — ca dễ, và không phải ca gây ra khoá mồ côi.
       */
      fetch: async (input, init) => {
        s2Calls += 1;
        const res = await fetch(input, init);
        if (!dropNextResponse) return res;
        dropNextResponse = false;
        await res.text();
        throw new DOMException(
          "The operation was aborted due to timeout",
          "TimeoutError",
        );
      },
    }),
  });
  world = testWorld(app, admin);
  owner = await world.newActor("res-owner");
  maintainer = await world.newActor("res-maint");
  developer = await world.newActor("res-dev");
  viewer = await world.newActor("res-viewer");
  outsider = await world.newActor("res-outsider");
  ({ projectId, envs } = await world.newProject(owner));
  other = await world.newProject(owner);
  await world.addMember(owner, projectId, maintainer, "MAINTAINER");
  await world.addMember(owner, projectId, developer, "DEVELOPER");
  await world.addMember(owner, projectId, viewer, "VIEWER");
}, 180_000);

afterAll(async () => {
  await s2?.stop();
  /** Tap chặn `fs.write` toàn tiến trình — nhả trước khi worker chạy file khác */
  logTap?.stop();
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
  await world?.cleanup();
  await admin.$disconnect();
});

// ==================================================================== quyền

describe("ma trận quyền của segment (L6, R08)", () => {
  const actorOf = (name: string): Actor =>
    ({ owner, maintainer, developer, viewer })[name] ?? outsider;

  it.each([
    ["owner", 200],
    ["maintainer", 200],
    ["developer", 200],
    ["viewer", 200],
    ["outsider", 404],
  ])("GET danh sách bằng %s ⇒ %i (đọc = VIEWER)", async (name, status) => {
    const before = s2Calls;
    await as(actorOf(name), request(app).get(segmentsUrl())).expect(status);
    /** Đường đọc của S1 không đi qua S2 dù thành công hay không (V19 không áp) */
    expect(s2Calls).toBe(before);
  });

  it.each([
    ["owner", 201],
    ["maintainer", 201],
    ["developer", 201],
    ["viewer", 403],
    ["outsider", 404],
  ])("POST bằng %s ⇒ %i (tạo = DEVELOPER)", async (name, status) => {
    const before = s2Calls;
    await as(
      actorOf(name),
      request(app)
        .post(segmentsUrl())
        .send({ name: named(`role-${name}`), conditions: oneUser }),
    ).expect(status);
    if (status >= 400) expect(s2Calls).toBe(before);
    else expect(s2Calls).toBe(before + 1);
  });

  /**
   * PUT đòi MAINTAINER, cao hơn POST và DELETE.
   *
   * Không phải tuỳ tiện: segment dùng chung MỌI environment, nên đổi `userIds`
   * của một segment mà rule production đang dùng là đổi ai nhận gì ở production —
   * đúng thứ DEVELOPER không được làm trên rule production (R08 (a)). Và đây là
   * phương án KHÔNG có TOCTOU: kiểm "segment này có được rule prod dùng không"
   * rồi mới quyết mức quyền là kiểm ngoài khoá, mà một rule prod thêm vào ngay
   * sau đó làm câu trả lời sai.
   */
  it.each([
    ["owner", 200],
    ["maintainer", 200],
    ["developer", 403],
    ["viewer", 403],
    ["outsider", 404],
  ])("PUT bằng %s ⇒ %i (sửa = MAINTAINER)", async (name, status) => {
    const segment = await newSegment();
    const before = s2Calls;
    await as(
      actorOf(name),
      request(app)
        .put(`${segmentsUrl()}/${segment.id}`)
        .send({
          name: named(`put-${name}`),
          description: null,
          conditions: oneUser,
          lastKnownUpdatedAt: segment.updatedAt,
        }),
    ).expect(status);
    if (status >= 400) expect(s2Calls).toBe(before);
  });

  it.each([
    ["owner", 204],
    ["maintainer", 204],
    ["developer", 204],
    ["viewer", 403],
    ["outsider", 404],
  ])("DELETE bằng %s ⇒ %i (xoá = DEVELOPER)", async (name, status) => {
    const segment = await newSegment();
    const before = s2Calls;
    await as(
      actorOf(name),
      request(app).delete(`${segmentsUrl()}/${segment.id}`),
    ).expect(status);
    if (status >= 400) expect(s2Calls).toBe(before);
  });
});

// ================================================================== sở hữu

describe("sở hữu id con (I14, R05)", () => {
  it("segment của project khác ở GET/PUT/DELETE ⇒ 404, S2 nhận 0 lời gọi", async () => {
    /** `owner` là thành viên của CẢ HAI project; `developer` chỉ của project chính */
    const foreign = await newSegment(owner, other.projectId);
    const before = s2Calls;

    await as(
      maintainer,
      request(app).get(`${segmentsUrl()}/${foreign.id}`),
    ).expect(404);
    await as(
      maintainer,
      request(app)
        .put(`${segmentsUrl()}/${foreign.id}`)
        .send({
          name: named("stolen"),
          description: null,
          conditions: oneUser,
          lastKnownUpdatedAt: foreign.updatedAt,
        }),
    ).expect(404);
    await as(
      maintainer,
      request(app).delete(`${segmentsUrl()}/${foreign.id}`),
    ).expect(404);

    expect(s2Calls).toBe(before);
    /** Và segment của project kia vẫn còn nguyên */
    expect(
      await admin.segment.findUnique({ where: { id: foreign.id } }),
    ).not.toBeNull();
  });

  it("id không phải UUID ⇒ 400, không 500", async () => {
    await as(
      maintainer,
      request(app).get(`${segmentsUrl()}/khong-uuid`),
    ).expect(400);
  });
});

// =================================================================== relay

describe("lỗi nghiệp vụ của S2 tới Portal nguyên vẹn (§9)", () => {
  it("trùng tên ⇒ 409 DUPLICATE_RESOURCE", async () => {
    const segment = await newSegment();
    const res = await as(
      developer,
      request(app)
        .post(segmentsUrl())
        .send({ name: segment.name, conditions: oneUser }),
    ).expect(409);
    expect(res.body.code).toBe("DUPLICATE_RESOURCE");
  });

  it("pattern ReDoS ⇒ 422 kèm lý do", async () => {
    const res = await as(
      developer,
      request(app)
        .post(segmentsUrl())
        .send({
          name: named("redos"),
          conditions: {
            all: [{ attribute: "email", operator: "regex", value: "^(a+)+$" }],
            userIds: [],
          },
        }),
    ).expect(422);
    expect(res.body.detail).toMatch(/ReDoS/);
  });

  it("mốc cũ ⇒ 409 OPTIMISTIC_LOCK kèm current", async () => {
    const segment = await newSegment();
    const body = (tag: string) => ({
      name: named(tag),
      description: null,
      conditions: oneUser,
      lastKnownUpdatedAt: segment.updatedAt,
    });
    await as(
      maintainer,
      request(app).put(`${segmentsUrl()}/${segment.id}`).send(body("first")),
    ).expect(200);
    const res = await as(
      maintainer,
      request(app).put(`${segmentsUrl()}/${segment.id}`).send(body("second")),
    ).expect(409);
    expect(res.body.code).toBe("OPTIMISTIC_LOCK");
    expect(res.body.current.updatedAt).toEqual(expect.any(String));
  });

  it("còn rule tham chiếu ⇒ 409 SEGMENT_IN_USE kèm resourceId là flag", async () => {
    const segment = await newSegment();
    const flag = await newFlag();
    const rulesUrl = `${API}/projects/${projectId}/flags/${flag.id}/envs/${envOf("dev").id}/rules`;
    const current = await as(developer, request(app).get(rulesUrl)).expect(200);
    await as(
      maintainer,
      request(app)
        .put(rulesUrl)
        .send({
          lastKnownUpdatedAt: current.body.updatedAt as string,
          rules: [
            {
              ruleType: "SEGMENT",
              condition: { segmentId: segment.id },
              serve: { kind: "variant", variantId: variantOf(flag) },
              priority: 1,
            },
          ],
        }),
    ).expect(200);

    const res = await as(
      developer,
      request(app).delete(`${segmentsUrl()}/${segment.id}`),
    ).expect(409);
    expect(res.body.code).toBe("SEGMENT_IN_USE");
    expect(res.body.resourceId).toBe(flag.id);
  });

  /**
   * Audit do Service 2 ghi phải mang người ĐÃ ĐĂNG NHẬP, không phải id mà Portal
   * tự khai trong header. Header `X-Udp-Actor-Id` chỉ đáng tin sau bí mật nội bộ,
   * và chính Service 1 là bên đặt nó — người dùng không chạm được vào đó.
   */
  it("audit mang người đăng nhập, không phải header Portal tự khai", async () => {
    const segment = await as(
      developer,
      request(app)
        .post(segmentsUrl())
        .send({ name: named("audited"), conditions: oneUser })
        .set("X-Udp-Actor-Id", outsider.userId),
    ).expect(201);
    const id = (segment.body.segment as SegmentView).id;
    const rows = await admin.auditLog.findMany({
      where: { targetId: id },
      select: { action: true, actorUserId: true },
    });
    expect(rows).toEqual([
      { action: "segment.create", actorUserId: developer.userId },
    ]);
  });
});

// ============================================================== hình dạng

describe("hình dạng response (§3.1, AC-3.11)", () => {
  it("danh sách mang summary + usage + quota, KHÔNG mang userIds, và dưới 10 KB", async () => {
    await newSegment(developer, projectId, {
      all: [{ attribute: "email", operator: "regex", value: "^[a-z]+$" }],
      userIds: userIds(500, "list"),
    });
    const res = await as(viewer, request(app).get(segmentsUrl())).expect(200);
    const body = res.body as {
      segments: SegmentView[];
      quota: {
        segmentCount: number;
        maxSegments: number;
        payloadBytes: number;
        maxPayloadBytes: number;
      };
    };

    expect(body.quota.maxSegments).toBe(SEGMENT.maxPerProject);
    expect(body.quota.maxPayloadBytes).toBe(SEGMENT.maxProjectBytes);
    expect(body.quota.segmentCount).toBe(body.segments.length);
    expect(body.quota.payloadBytes).toBeGreaterThan(0);

    const withRegex = body.segments.find((s) => s.summary.hasRegex);
    expect(withRegex?.summary.conditionCount).toBe(1);
    expect(withRegex?.summary.userIdCount).toBe(500);
    expect(withRegex?.summary.payloadBytes).toBeGreaterThan(500 * 256);

    const raw = JSON.stringify(body);
    expect(raw).not.toContain("userIds");
    expect(raw).not.toContain("conditions");
    expect(raw).not.toContain("projectId");
    /** AC-3.11 — trang danh sách phải nhẹ, và đó là lý do list chỉ trả số đếm */
    expect(Buffer.byteLength(raw, "utf8")).toBeLessThan(10_000);
  });

  it("chi tiết mang conditions đầy đủ và danh sách flag đang dùng", async () => {
    const segment = await newSegment(developer, projectId, {
      all: [],
      userIds: ["u-detail-1", "u-detail-2"],
    });
    const res = await as(
      viewer,
      request(app).get(`${segmentsUrl()}/${segment.id}`),
    ).expect(200);
    const detail = res.body.segment as SegmentView & {
      conditions: { all: unknown[]; userIds: string[] };
      usage: {
        flagCount: number;
        productionFlagCount: number;
        flags: unknown[];
      };
    };
    expect(detail.conditions.userIds).toEqual(["u-detail-1", "u-detail-2"]);
    expect(detail.usage.flags).toEqual([]);
    expect(detail.summary.userIdCount).toBe(2);
  });

  it("search khớp một phần tên, không phân biệt hoa thường", async () => {
    const tag = `needle${randomUUID().slice(0, 6)}`;
    await newSegment(developer, projectId, oneUser);
    const target = await as(
      developer,
      request(app)
        .post(segmentsUrl())
        .send({ name: `x-${tag}-y`, conditions: oneUser }),
    ).expect(201);
    const res = await as(
      viewer,
      request(app).get(segmentsUrl()).query({ search: tag.toUpperCase() }),
    ).expect(200);
    expect((res.body.segments as SegmentView[]).map((s) => s.id)).toEqual([
      (target.body.segment as SegmentView).id,
    ]);
  });
});

// ================================================================== parser

describe("thân lớn chỉ được parse sau guard (V14, V15, INV-23.8)", () => {
  /**
   * Thân là JSON HỎNG: nếu parser chạy trước guard thì câu trả lời là 400. Phép
   * kiểm không phụ thuộc kích thước hay đồng hồ, nên nó tất định.
   */
  it("thân hỏng của người vô danh ⇒ 403, KHÔNG phải 400", async () => {
    const res = await request(app)
      .post(segmentsUrl())
      .set("content-type", "application/json")
      .send('{"broken":');
    expect(res.status).toBe(403);
  });

  it("thân hỏng của VIEWER ⇒ 403 (quyền chặn trước parser)", async () => {
    const res = await as(
      viewer,
      request(app)
        .post(segmentsUrl())
        .set("content-type", "application/json")
        .send('{"broken":'),
    );
    expect(res.status).toBe(403);
  });

  /**
   * 16 MiB vô danh: server trả lời rồi đóng kết nối trong lúc client vẫn đang
   * tải lên, nên `supertest` thấy 401/403 HOẶC thấy kết nối bị cắt. Cả ba kết cục
   * đều chứng minh điều cần chứng minh — không có 400 (thân hỏng đã bị parse) và
   * không có 413 (parser 1 MB đã chạy).
   */
  it("thân 16 MiB vô danh không bao giờ được parse", async () => {
    const outcome = await request(app)
      .post(segmentsUrl())
      .set("content-type", "application/json")
      .send(`{"broken":"${"x".repeat(16 * 1024 * 1024)}`)
      .then((res) => res.status as number | string)
      .catch((err: unknown) => (err as { code?: string }).code ?? "ERR");
    expect([401, 403, "ECONNRESET", "EPIPE"]).toContain(outcome);
  }, 60_000);

  /**
   * Đường dẫn KHÁC HOA THƯỜNG và có `/` cuối vẫn đi tới route segment (Express
   * khớp như vậy), nên nó cũng phải đi đúng parser lớn. Vị từ so khớp trên chuỗi
   * thô sẽ trượt ca này, và khi đó parser 1 MB toàn cục chặn 413 một thân hoàn
   * toàn hợp lệ.
   */
  it("`/API/V1/…/SEGMENTS/` vẫn đi parser lớn: thân 1,9 MB ⇒ 201", async () => {
    const shouty = `/API/V1/PROJECTS/${projectId}/SEGMENTS/`;
    const res = await as(
      developer,
      request(app)
        .post(shouty)
        .send({
          name: named("shouty"),
          conditions: { all: [], userIds: userIds(7_500, "shouty") },
        }),
    );
    expect(res.status).toBe(201);
  }, 60_000);

  /**
   * AC-3.10 — segment ở trần schema, gửi bằng escape `\\uXXXX` cho MỌI ký tự.
   *
   * Đây là ca mà hằng `writeBodyLimitBytes = 16 MiB` tồn tại để phục vụ: 10 000
   * userId × 256 ký tự ASCII chỉ 2 590 022 B ở dạng canonical, nhưng một client
   * escape mọi ký tự (thứ JSON cho phép, và thứ vài thư viện làm) gửi 15,4 MB
   * trên DÂY. Trần tính theo canonical thì request hoàn toàn hợp lệ này nhận 413
   * — và người dùng không có cách nào hiểu vì sao.
   *
   * Service 2 nới trần thêm 64 KiB vì Service 1 serialize LẠI thân (lúc đó đã
   * gọn, ~2,6 MB) và thêm `projectId`, nên chiều S1 → S2 còn xa trần của nó.
   */
  it("thân 15,4 MB gửi bằng escape cho mọi ký tự ⇒ 201 (AC-3.10)", async () => {
    const hex = (c: string): string =>
      "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0");
    const escaped = userIds(CONDITION_LIMITS.userIdsMax, "esc")
      .map((id) => `"${[...id].map(hex).join("")}"`)
      .join(",");
    const raw = `{"name":"${named("escaped")}","conditions":{"all":[],"userIds":[${escaped}]}}`;
    const wire = Buffer.byteLength(raw, "utf8");
    expect(wire).toBeGreaterThan(15_000_000);
    expect(wire).toBeLessThanOrEqual(SEGMENT.writeBodyLimitBytes);

    const res = await as(
      owner,
      request(app)
        .post(segmentsUrl(other.projectId))
        .set("content-type", "application/json")
        .send(raw),
    );
    expect(res.status).toBe(201);
    /** Và thứ được LƯU là dạng canonical, không phải 15,4 MB kia */
    expect((res.body.segment as SegmentView).summary.userIdCount).toBe(
      CONDITION_LIMITS.userIdsMax,
    );
  }, 180_000);

  /**
   * Thân VƯỢT trần riêng ⇒ 413 problem+json, không 500.
   *
   * `errorHandler` chung dịch được JSON hỏng nhưng không biết `entity.too.large`,
   * nên thiếu `jsonTooLargeHandler` thì một thân quá trần trả "Lỗi hệ thống" — và
   * bảo client thử lại một request không bao giờ đúng. Server có thể cắt kết nối
   * giữa lúc client còn đang tải, nên `ECONNRESET` cũng là kết cục hợp lệ; thứ
   * KHÔNG được xảy ra là 500 hay 201.
   */
  it("thân vượt trần 16 MiB ⇒ 413, không 500", async () => {
    const outcome = await as(
      developer,
      request(app)
        .post(segmentsUrl())
        .set("content-type", "application/json")
        .send(
          `{"name":"too-big","conditions":{"all":[],"userIds":["${"x".repeat(
            SEGMENT.writeBodyLimitBytes,
          )}"]}}`,
        ),
    )
      .then((res) => ({
        status: res.status as number | string,
        title: res.body.title as unknown,
      }))
      .catch((err: unknown) => ({
        status: (err as { code?: string }).code ?? "ERR",
        title: undefined,
      }));
    if (typeof outcome.status === "number") {
      expect(outcome.status).toBe(413);
      expect(outcome.title).toBe("Payload too large");
    } else {
      expect(["ECONNRESET", "EPIPE"]).toContain(outcome.status);
    }
  }, 120_000);
});

// ================================================================= SDK key

describe("ma trận quyền của SDK key (L7)", () => {
  const actorOf = (name: string): Actor =>
    ({ owner, maintainer, developer, viewer })[name] ?? outsider;

  it.each([
    ["owner", 200],
    ["maintainer", 200],
    ["developer", 200],
    ["viewer", 200],
    ["outsider", 404],
  ])("GET danh sách bằng %s ⇒ %i (đọc = VIEWER)", async (name, status) => {
    const before = s2Calls;
    await as(actorOf(name), request(app).get(keysUrl())).expect(status);
    /** Đường đọc khoá của S1 đọc thẳng database — `udp_s1` có SELECT trên bảng này */
    expect(s2Calls).toBe(before);
  });

  /**
   * Tạo khoá là OWNER, không MAINTAINER (L7).
   *
   * Một khoá SERVER đọc được TOÀN BỘ rule và `userIds` của environment qua
   * `/sdk/config`, và nó sống tới khi ai đó thu hồi. Đó là quyết định cấp phát
   * credential, cùng hạng với chuyển quyền sở hữu project — không cùng hạng với
   * sửa một rule.
   */
  it.each([
    ["owner", 201],
    ["maintainer", 403],
    ["developer", 403],
    ["viewer", 403],
    ["outsider", 404],
  ])("POST bằng %s ⇒ %i (tạo = OWNER)", async (name, status) => {
    const before = s2Calls;
    await as(
      actorOf(name),
      request(app).post(keysUrl()).send({ keyType: "SERVER", label: name }),
    ).expect(status);
    if (status >= 400) expect(s2Calls).toBe(before);
    else expect(s2Calls).toBe(before + 1);
  });

  it.each([
    ["owner", 200],
    ["maintainer", 403],
    ["developer", 403],
    ["viewer", 403],
    ["outsider", 404],
  ])("DELETE bằng %s ⇒ %i (thu hồi = OWNER)", async (name, status) => {
    const key = await newKey();
    const before = s2Calls;
    await as(
      actorOf(name),
      request(app).delete(`${keysUrl()}/${key.id}`),
    ).expect(status);
    if (status >= 400) expect(s2Calls).toBe(before);
  });
});

describe("hình dạng khoá vừa phát hành (§3.1, V3, AC-4.1)", () => {
  it("SERVER: secretKey khớp ^udp_sk_dev_[0-9a-f]{64}$, maskedKey là udp_sk_… + 6 hex", async () => {
    const res = await as(
      owner,
      request(app)
        .post(keysUrl())
        .send({ keyType: "SERVER", label: "prod-api" }),
    ).expect(201);
    const body = res.body as CreatedKeyBody;

    /** Trường tên `secretKey`, không `key`/`plaintext`/`token` (V3, R04 (a)) */
    expect(body.secretKey).toMatch(/^udp_sk_dev_[0-9a-f]{64}$/);
    expect(body.key.maskedKey).toBe(
      `${SDK_KEY.serverPrefix}…${body.secretKey.slice(-SDK_KEY.displaySuffixLength)}`,
    );
    expect(body.key.keySuffix).toBe(
      body.secretKey.slice(-SDK_KEY.displaySuffixLength),
    );
    expect(body.key.status).toBe("active");
    expect(body.key.keyType).toBe("SERVER");
    expect(body.key.label).toBe("prod-api");
    expect(body.key.environmentId).toBe(envOf("dev").id);
    expect(body.key.createdBy).toEqual({ id: owner.userId, name: "Test User" });
    expect(body.key.lastUsedAt).toBeNull();
    expect(body.key.revokedAt).toBeNull();

    /** Hash không bao giờ lên dây — nhưng hàng trong database đúng là hash của token */
    expect(JSON.stringify(body)).not.toContain("keyHash");
    const row = await admin.sdkKey.findUniqueOrThrow({
      where: { id: body.key.id },
      select: { keyHash: true },
    });
    expect(row.keyHash).toBe(sdkKeyMaterialOf(body.secretKey).keyHash);
  });

  it("CLIENT: secretKey khớp ^udp_ck_dev_[0-9a-f]{64}$ (AC-4.1)", async () => {
    const res = await as(
      owner,
      request(app).post(keysUrl()).send({ keyType: "CLIENT" }),
    ).expect(201);
    const body = res.body as CreatedKeyBody;
    expect(body.secretKey).toMatch(/^udp_ck_dev_[0-9a-f]{64}$/);
    expect(body.key.maskedKey.startsWith(SDK_KEY.clientPrefix)).toBe(true);
    /** `label` không gửi ⇒ `null`, không phải chuỗi rỗng */
    expect(body.key.label).toBeNull();
  });

  /**
   * `Cache-Control: no-store` + `Pragma: no-cache` (R04 (e)).
   *
   * Đây là response DUY NHẤT trong cả API mang một bí mật dùng được ngay. Thiếu
   * hai header này thì một proxy trên đường, hay chính trình duyệt, có thể giữ lại
   * nó — và một bí mật nằm trong cache là một bí mật không ai biết để thu hồi.
   */
  it("response tạo mang no-store và no-cache", async () => {
    const res = await as(
      owner,
      request(app).post(keysUrl()).send({ keyType: "SERVER" }),
    ).expect(201);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.headers.pragma).toBe("no-cache");
  });

  /**
   * `Idempotency-Key` bị BỎ QUA, không bị từ chối (R04 (b), G15).
   *
   * Nếu ai đó gắn `idempotent()` vào route này thì middleware lưu nguyên thân
   * response 2xx vào `idempotency_keys.response_body` và phát lại trong 24 giờ —
   * plaintext nằm trong database, đúng thứ thiết kế cấm. Hai POST cùng một
   * `Idempotency-Key` vì thế phải ra HAI khoá KHÁC nhau (không phát lại), và bảng
   * `idempotency_keys` không được có hàng nào cho đường dẫn này.
   */
  it("hai POST cùng Idempotency-Key ⇒ hai khoá khác nhau, không hàng idempotency nào", async () => {
    const send = () =>
      as(
        owner,
        request(app)
          .post(keysUrl())
          .set("Idempotency-Key", "11111111-1111-4111-8111-111111111111")
          .send({ keyType: "SERVER" }),
      ).expect(201);

    const first = (await send()).body as CreatedKeyBody;
    const second = (await send()).body as CreatedKeyBody;

    expect(second.key.id).not.toBe(first.key.id);
    expect(second.secretKey).not.toBe(first.secretKey);
    expect(
      await admin.idempotencyKey.count({
        where: { endpoint: { contains: "keys" } },
      }),
    ).toBe(0);
  });
});

describe("danh sách khoá (§3.1)", () => {
  /**
   * Project RIÊNG cho ca này, và đọc bằng `owner`.
   *
   * Riêng vì thứ tự "khoá sống trước, rồi khoá đã thu hồi" chỉ khẳng định được
   * trên một environment mà ca này biết hết nội dung — các ca ma trận quyền ở trên
   * đã rải khoá khắp env `dev` của project chính. Bằng `owner` vì `viewer` không
   * phải thành viên của project vừa tạo (nó sẽ nhận 404, đúng theo I14); còn việc
   * VIEWER đọc được danh sách đã có ô riêng trong ma trận quyền.
   */
  it("khoá sống trước khoá đã thu hồi; không có hash, không có secretKey", async () => {
    const project = await world.newProject(owner);
    const url = `${API}/projects/${project.projectId}/environments/${project.envs.dev?.id ?? ""}/keys`;

    const alive = (await as(
      owner,
      request(app).post(url).send({ keyType: "SERVER", label: "alive" }),
    ).expect(201)) as { body: CreatedKeyBody };
    const doomed = (await as(
      owner,
      request(app).post(url).send({ keyType: "CLIENT", label: "doomed" }),
    ).expect(201)) as { body: CreatedKeyBody };
    await as(owner, request(app).delete(`${url}/${doomed.body.key.id}`)).expect(
      200,
    );

    const res = await as(owner, request(app).get(url)).expect(200);
    const keys = (res.body as { keys: KeyView[] }).keys;
    expect(keys.map((k) => k.id)).toEqual([
      alive.body.key.id,
      doomed.body.key.id,
    ]);
    expect(keys.map((k) => k.status)).toEqual(["active", "revoked"]);

    const raw = JSON.stringify(res.body);
    expect(raw).not.toContain("keyHash");
    expect(raw).not.toContain("secretKey");
    expect(raw).not.toContain(alive.body.secretKey);

    /** `status` lọc đúng hai nhóm */
    const onlyActive = await as(
      owner,
      request(app).get(url).query({ status: "active" }),
    ).expect(200);
    expect(
      (onlyActive.body as { keys: KeyView[] }).keys.map((k) => k.id),
    ).toEqual([alive.body.key.id]);
    const onlyRevoked = await as(
      owner,
      request(app).get(url).query({ status: "revoked" }),
    ).expect(200);
    expect(
      (onlyRevoked.body as { keys: KeyView[] }).keys.map((k) => k.id),
    ).toEqual([doomed.body.key.id]);
  }, 60_000);

  it("status lạ ⇒ 400 (query strict)", async () => {
    await as(
      viewer,
      request(app).get(keysUrl()).query({ status: "all-of-them" }),
    ).expect(400);
    await as(viewer, request(app).get(keysUrl()).query({ hack: 1 })).expect(
      400,
    );
  });
});

describe("thu hồi qua S1 (§3.1, AC-4.6)", () => {
  it("thu hồi ⇒ 200 kèm khoá đã thu hồi; lần hai trả ĐÚNG mốc cũ", async () => {
    const key = await newKey();
    const first = await as(
      owner,
      request(app).delete(`${keysUrl()}/${key.id}`),
    ).expect(200);
    const revoked = (first.body as { key: KeyView }).key;
    expect(revoked.status).toBe("revoked");
    expect(revoked.revokedAt).toEqual(expect.any(String));

    const second = await as(
      owner,
      request(app).delete(`${keysUrl()}/${key.id}`),
    ).expect(200);
    expect((second.body as { key: KeyView }).key.revokedAt).toBe(
      revoked.revokedAt,
    );

    /** Một hàng audit `sdkkey.revoke` cho cả hai lần gọi */
    const rows = await admin.auditLog.findMany({
      where: { targetId: key.id, action: "sdkkey.revoke" },
      select: { actorUserId: true },
    });
    expect(rows).toEqual([{ actorUserId: owner.userId }]);
  }, 60_000);
});

describe("sở hữu environment và khoá (I14, R05)", () => {
  it("environment của project khác ⇒ 404 ở cả ba route, S2 nhận 0 lời gọi", async () => {
    const foreignEnv = other.envs.dev?.id ?? "";
    const url = `${API}/projects/${projectId}/environments/${foreignEnv}/keys`;
    const before = s2Calls;

    await as(owner, request(app).get(url)).expect(404);
    await as(owner, request(app).post(url).send({ keyType: "SERVER" })).expect(
      404,
    );
    await as(owner, request(app).delete(`${url}/${randomUUID()}`)).expect(404);

    expect(s2Calls).toBe(before);
  });

  /**
   * Khoá của environment KHÁC trong CÙNG project ⇒ 404.
   *
   * Ô khó nhất của ma trận: người gọi là OWNER thật của project, environment trên
   * đường dẫn cũng thật và thuộc project ấy — chỉ `:keyId` là của environment
   * khác. Thiếu `environment_id` trong câu đọc khoá thì đây là một lần thu hồi
   * thành công vào environment người gọi không nhắm tới.
   */
  it("khoá của environment khác cùng project ⇒ 404, khoá vẫn sống, S2 nhận 0 lời gọi", async () => {
    const key = await newKey();
    const staging = envOf("staging").id;
    const before = s2Calls;

    await as(
      owner,
      request(app).delete(
        `${API}/projects/${projectId}/environments/${staging}/keys/${key.id}`,
      ),
    ).expect(404);

    expect(s2Calls).toBe(before);
    const row = await admin.sdkKey.findUniqueOrThrow({
      where: { id: key.id },
      select: { revokedAt: true },
    });
    expect(row.revokedAt).toBeNull();
  }, 60_000);

  it("khoá không tồn tại ⇒ 404; id không phải UUID ⇒ 400", async () => {
    await as(owner, request(app).delete(`${keysUrl()}/${randomUUID()}`)).expect(
      404,
    );
    await as(owner, request(app).delete(`${keysUrl()}/khong-uuid`)).expect(400);
    await as(
      owner,
      request(app).get(
        `${API}/projects/${projectId}/environments/khong-uuid/keys`,
      ),
    ).expect(400);
  });
});

describe("hợp đồng thân strict (R36)", () => {
  it.each([
    ["trường lạ", { keyType: "SERVER", keyHash: "a".repeat(64) }],
    ["environmentId trong thân", { keyType: "SERVER", environmentId: "x" }],
    ["loại khoá lạ", { keyType: "ADMIN" }],
    ["thiếu keyType", { label: "no-type" }],
    ["label rỗng", { keyType: "SERVER", label: "" }],
    [
      "label quá dài",
      { keyType: "SERVER", label: "x".repeat(SDK_KEY.labelMaxLength + 1) },
    ],
  ])("POST %s ⇒ 400", async (_name, body) => {
    const before = s2Calls;
    await as(owner, request(app).post(keysUrl()).send(body)).expect(400);
    expect(s2Calls).toBe(before);
  });
});

describe("thử lại đúng một lần khi S2 đã commit (R24, V4, AC-5.5)", () => {
  /**
   * Hình dạng mà R24 mô tả, dựng lại đúng như vậy: Service 2 commit, response
   * mất, Service 1 thử lại với CÙNG vật liệu.
   *
   * Ba điều phải đồng thời đúng, và thiếu bất kỳ cái nào là một lỗi khác nhau:
   * người dùng nhận 201 (không phải 503 cho một khoá đã tồn tại), plaintext trong
   * response là CHÍNH token đã được băm vào hàng đó (không phải token của lần thử
   * thứ hai), và database có ĐÚNG một hàng (không phải hai khoá cho một lần bấm).
   */
  it("S2 commit rồi mất response ⇒ 201 kèm plaintext, và đúng MỘT hàng sdk_keys", async () => {
    const project = await world.newProject(owner);
    const environmentId = project.envs.dev?.id ?? "";
    const url = `${API}/projects/${project.projectId}/environments/${environmentId}/keys`;

    const before = s2Calls;
    dropNextResponse = true;
    const res = await as(
      owner,
      request(app).post(url).send({ keyType: "SERVER", label: "retried" }),
    ).expect(201);
    const body = res.body as CreatedKeyBody;

    /** Đúng hai lời gọi: lần bị mất response, và lần thử lại duy nhất */
    expect(s2Calls).toBe(before + 2);
    expect(dropNextResponse).toBe(false);

    const rows = await admin.sdkKey.findMany({
      where: { environmentId },
      select: { id: true, keyHash: true },
    });
    expect(rows).toEqual([
      { id: body.key.id, keyHash: sdkKeyMaterialOf(body.secretKey).keyHash },
    ]);

    /** Và đúng một hàng audit: lần thử lại không ghi thêm gì (V4) */
    expect(
      await admin.auditLog.count({
        where: { targetId: body.key.id, action: "sdkkey.create" },
      }),
    ).toBe(1);
  }, 60_000);

  /**
   * AC-5.5 — lần thử lại ở environment đã có 19 khoá.
   *
   * Đây là ca mà thứ tự "tra hash TRƯỚC khi đếm quota" tồn tại để phục vụ (C-05):
   * nếu quota được đếm trước, lần thử lại đọc 20/20 và trả 422 cho CHÍNH khoá vừa
   * tạo — người dùng nhận lỗi, plaintext mất, và khoá thì đang nằm trong database.
   */
  it("env có 19 khoá, mất response ⇒ 201 cho người dùng và đúng 20 khoá (AC-5.5)", async () => {
    const project = await world.newProject(owner);
    const environmentId = project.envs.dev?.id ?? "";
    const url = `${API}/projects/${project.projectId}/environments/${environmentId}/keys`;

    /**
     * 19 khoá đầu chèn THẲNG bằng owner, một câu: chúng là TRẠNG THÁI, không phải
     * hành vi cần kiểm.
     *
     * Trước đó chúng được tạo qua route — 19 lời gọi, mỗi lời một lượt S1 → S2 và
     * một lượt đọc lại, tức khoảng 40 vòng đi về tới database ở Singapore cho một
     * tiền đề. Đường ghi qua route đã có ca riêng ở ngay trên và cả một file ở
     * Service 2; ở đây chỉ cần environment THẬT SỰ có 19 khoá sống lúc lời gọi thứ
     * 20 chạy. Đổi lại: test nhanh hơn ~16 giây và mở ra ít cửa sổ lỗi mạng hơn.
     */
    await admin.sdkKey.createMany({
      data: Array.from(
        { length: SDK_KEY.maxActivePerEnvironment - 1 },
        (_, i) => ({
          environmentId,
          keyType: "SERVER" as const,
          label: `seed-${String(i)}`,
          createdById: owner.userId,
          ...sdkKeyMaterialOf(issueSdkKeyToken("SERVER", "dev")),
        }),
      ),
    });

    dropNextResponse = true;
    const res = await as(
      owner,
      request(app).post(url).send({ keyType: "SERVER", label: "the-20th" }),
    ).expect(201);
    const body = res.body as CreatedKeyBody;

    expect(
      await admin.sdkKey.count({ where: { environmentId, revokedAt: null } }),
    ).toBe(SDK_KEY.maxActivePerEnvironment);
    expect(body.secretKey).toMatch(/^udp_sk_dev_[0-9a-f]{64}$/);

    /** Khoá thứ 21 thì 422 — trần vẫn là trần */
    const full = await as(
      owner,
      request(app).post(url).send({ keyType: "SERVER" }),
    ).expect(422);
    expect(full.body.code).toBe("QUOTA_EXCEEDED");
  }, 180_000);
});

describe("INV-23.3 — plaintext không rò ra đâu cả (R04)", () => {
  /**
   * Phép quét cuối: một khoá thật, rồi tìm plaintext của nó ở MỌI nơi nó có thể
   * lọt vào.
   *
   * Bốn mặt, và mỗi mặt là một kịch bản R04 kể:
   *
   *   (a) **Database, mọi bảng.** Không chỉ bốn bảng đã nghĩ tới
   *       (`audit_logs`, `idempotency_keys`, `config_change_log`, `sdk_keys`):
   *       `scanForSecret` đọc danh sách bảng từ `information_schema` lúc chạy, nên
   *       một cột hay một bảng thêm sau này cũng được quét mà không ai sửa test.
   *   (b) **Log của Service 1**, thu ở tầng `fs.write` — tức đúng những byte pino
   *       đã ghi, SAU khi `redactPaths` chạy.
   *   (c) **Log của Service 2**, đọc từ stdout của tiến trình con. Ở đây phép kiểm
   *       mạnh hơn một lời hứa: Service 2 chưa từng NHẬN plaintext, nên nó không
   *       có gì để ghi (L7).
   *   (d) **Theo MẪU, không chỉ theo token này.** Lần quét thứ hai dùng
   *       `SDK_KEY_PLAINTEXT_PATTERN`, nên nó bắt cả khoá do những ca test khác
   *       trong file này làm rò.
   *
   * `logTap.settle()` chạy TRƯỚC khi đọc: nó vừa đẩy phần còn trong bộ đệm của
   * pino ra, vừa chứng minh tap còn hoạt động — một phép quét trên một chuỗi rỗng
   * sẽ xanh y như vậy mà không kiểm gì.
   */
  it("plaintext không có trong database, không trong log S1, không trong log S2", async () => {
    const res = await as(
      owner,
      request(app)
        .post(keysUrl())
        .send({ keyType: "SERVER", label: "scanned" }),
    ).expect(201);
    const body = res.body as CreatedKeyBody;

    /** Cả một lần thu hồi nữa: đường ghi thứ hai, qua outbox */
    await as(owner, request(app).delete(`${keysUrl()}/${body.key.id}`)).expect(
      200,
    );

    /** Và một lần dùng khoá, để `last_used_at` và guard của S2 cùng chạm vào nó */
    await as(viewer, request(app).get(keysUrl())).expect(200);

    if (logTap === undefined) throw new Error("logTap chưa được dựng");
    await logTap.settle();
    const s1Log = logTap.text();
    const s2Log = s2?.output() ?? "";

    /** Chốt chống rỗng: hai nguồn log phải THẬT SỰ có nội dung */
    expect(s1Log.length).toBeGreaterThan(0);
    expect(s2Log.length).toBeGreaterThan(0);

    expect(await scanForSecret(admin, body.secretKey)).toEqual([]);
    expect(
      await scanForSecret(admin, SDK_KEY_PLAINTEXT_PATTERN.source),
    ).toEqual([]);

    expect(s1Log).not.toContain(body.secretKey);
    expect(s2Log).not.toContain(body.secretKey);
    expect(s1Log).not.toMatch(SDK_KEY_PLAINTEXT_PATTERN);
    expect(s2Log).not.toMatch(SDK_KEY_PLAINTEXT_PATTERN);

    /** Hash cũng không đi vào log của S1 — nó chỉ nên nằm ở cột `key_hash` */
    expect(s1Log).not.toContain(sdkKeyMaterialOf(body.secretKey).keyHash);
  }, 180_000);
});

// ------------------------------------------------------------------ helper

interface FlagView {
  id: string;
  variants: { id: string; key: string }[];
}

async function newFlag(): Promise<FlagView> {
  const res = await as(
    developer,
    request(app)
      .post(`${API}/projects/${projectId}/flags`)
      .send({ key: `pr-${randomUUID().slice(0, 8)}`, flagType: "BOOLEAN" }),
  ).expect(201);
  return res.body.flag as FlagView;
}

const variantOf = (flag: FlagView): string => {
  const variant = flag.variants[0];
  if (variant === undefined) throw new Error("flag thiếu variant");
  return variant.id;
};

/** [v4.9] Hình một khoá trên dây (§3.1) — không có `keyHash`, không có plaintext */
interface KeyView {
  id: string;
  environmentId: string;
  keyType: string;
  label: string | null;
  keySuffix: string;
  maskedKey: string;
  status: string;
  createdBy: { id: string; name: string };
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

/** Response của `POST …/keys`: khoá, và plaintext ở một trường RIÊNG (V3) */
interface CreatedKeyBody {
  key: KeyView;
  secretKey: string;
}

/** Khoá SERVER mới ở env `dev` của project chính */
async function newKey(): Promise<KeyView> {
  const res = await as(
    owner,
    request(app).post(keysUrl()).send({ keyType: "SERVER" }),
  ).expect(201);
  return (res.body as CreatedKeyBody).key;
}

const envOf = (name: string): ProjectEnv => {
  const found = envs[name];
  if (found === undefined) throw new Error(`thiếu env ${name}`);
  return found;
};
