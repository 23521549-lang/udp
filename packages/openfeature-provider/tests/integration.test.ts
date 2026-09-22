import { randomUUID } from "node:crypto";
import {
  OpenFeature,
  ProviderEvents,
  type EvaluationDetails,
  type FlagValue,
} from "@openfeature/server-sdk";
import { env } from "@udp/config";
import { createPrismaClient } from "@udp/db";
import {
  configHashOf,
  fromOfrep,
  normalizeSnapshot,
} from "@udp/flag-evaluator";
import type { Evaluation, OfrepFailure, OfrepSuccess } from "@udp/shared-types";
import {
  createActiveFlag,
  I26_EXAMPLES,
  i26Arbitraries,
  i26SegmentConditions,
  internalCall,
  issueSdkKey,
  stableOwner,
  startFlagService,
  type RunningService,
} from "@udp/test-support";
import fc from "fast-check";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { UDPFeatureFlagProvider } from "../src/index.js";
import { ConfigStore, createProviderForTesting } from "../src/testing.js";
import {
  HttpTransport,
  type ConfigResult,
  type StreamOpen,
  type Transport,
} from "../src/transport.js";
import { waitFor } from "./helpers/wait.js";

/**
 * Provider với Service 2 THẬT (tiến trình con, `CHANGEFEED_MODE=delta`) [v4.7]:
 *   - I15c: sau một chuỗi ghi thật, cache của provider (dựng bằng DELTA, không một
 *     lần RESYNC) trùng `/sdk/config` cùng version — cả nội dung lẫn hash.
 *   - I26 qua provider: `getStringDetails` và OFREP cho cùng kết quả.
 *   - Khoá bị thu hồi ⇒ ERROR, vẫn phục vụ cấu hình cuối; khôi phục ⇒ READY.
 *   - I34: Service 2 chết ⇒ STALE, vẫn phục vụ; sống lại ⇒ READY.
 */

const admin = createPrismaClient({
  connectionString: env.DATABASE_URL_DIRECT,
  max: 3,
  cacheKey: `__udp_prisma_provider_it_${randomUUID()}`,
});
const SEG_PRO = randomUUID();
const SEG_USERS = randomUUID();

let s2: RunningService;
let actorId: string;
let projectId: string | undefined;
let envId: string;
let serverKey: string;
let clientKey: string;
/** env-config của flag `i15-a` — I34 ghi lên nó để kiểm hội tụ */
let i15ConfigId = "";

/** Transport thật, ghi lại con trỏ của mỗi lần mở stream */
class RecordingTransport implements Transport {
  readonly streamCalls: (number | undefined)[] = [];
  constructor(private readonly inner: Transport) {}
  getConfig(
    ifNoneMatch: string | undefined,
    signal: AbortSignal,
  ): Promise<ConfigResult> {
    return this.inner.getConfig(ifNoneMatch, signal);
  }
  openStream(
    since: number | undefined,
    signal: AbortSignal,
  ): Promise<StreamOpen> {
    this.streamCalls.push(since);
    return this.inner.openStream(since, signal);
  }
}

const store = new ConfigStore();
let transport: RecordingTransport;
let provider: UDPFeatureFlagProvider;
const changed: string[] = [];

beforeAll(async () => {
  actorId = (await stableOwner(admin)).id;
  const suffix = randomUUID().slice(0, 8);
  const segments = i26SegmentConditions();
  const project = await admin.project.create({
    data: {
      ownerId: actorId,
      name: `provider-it-${suffix}`,
      creationMode: "CREATE_NEW",
      languageRuntime: "nodejs",
      resourceQuota: {},
      environments: {
        create: [{ name: "dev", rank: 0, k8sNamespace: `udp-prov-${suffix}` }],
      },
      segments: {
        create: [
          { id: SEG_PRO, name: "pro", conditions: segments.pro },
          { id: SEG_USERS, name: "users", conditions: segments.users },
        ],
      },
    },
    select: { id: true, environments: { select: { id: true } } },
  });
  projectId = project.id;
  envId = project.environments[0]?.id ?? "";
  serverKey = await issueSdkKey(admin, {
    environmentId: envId,
    keyType: "SERVER",
    createdById: actorId,
  });
  clientKey = await issueSdkKey(admin, {
    environmentId: envId,
    keyType: "CLIENT",
    createdById: actorId,
  });

  s2 = await startFlagService({ env: { CHANGEFEED_MODE: "delta" } });
  transport = new RecordingTransport(new HttpTransport(s2.baseUrl, serverKey));
  provider = createProviderForTesting(
    // 1 giây: đang 401 thì provider thử `/sdk/config` mỗi chu kỳ, và limiter của nó
    // (100/phút/khoá) đếm cả lần bị từ chối — nhanh hơn là tự chuốc 429
    { host: s2.baseUrl, sdkKey: serverKey, pollingIntervalMs: 1_000 },
    { transport, store, sync: { backoffMinMs: 100 } },
  );
  await OpenFeature.setProviderAndWait("main", provider);
  OpenFeature.getClient("main").addHandler(
    ProviderEvents.ConfigurationChanged,
    (e) => {
      changed.push(...(e?.flagsChanged ?? []));
    },
  );
}, 90_000);

afterAll(async () => {
  try {
    await OpenFeature.close();
    // `beforeAll` hỏng trước khi S2 lên thì không có gì để dừng — nhưng project đã
    // tạo vẫn phải được dọn
    await (s2 as RunningService | undefined)?.stop();
  } finally {
    if (projectId !== undefined) {
      await admin.configChangeLog.deleteMany({
        where: { environmentId: envId },
      });
      await admin.auditLog.deleteMany({ where: { projectId } });
      await admin.project.delete({ where: { id: projectId } });
    }
    await admin.$disconnect();
  }
}, 60_000);

async function dbVersion(): Promise<number> {
  const { configVersion } = await admin.environment.findUniqueOrThrow({
    where: { id: envId },
    select: { configVersion: true },
  });
  return configVersion;
}

/** Provider đã áp ĐÚNG version hiện tại của database */
async function providerCaughtUp(): Promise<number> {
  const target = await dbVersion();
  await waitFor(() => provider.configVersion === target, 15_000);
  return target;
}

const call = (req: request.Test) => internalCall(req, actorId);

async function envConfigOf(flagId: string) {
  return admin.flagEnvConfig.findFirstOrThrow({
    where: { flagId, environmentId: envId },
    select: { id: true, updatedAt: true },
  });
}

describe("bootstrap và I15c — cache dựng bằng delta trùng /sdk/config", () => {
  it("chuỗi ghi thật (DRAFT, kích hoạt, rule, env, tracked) ⇒ cùng nội dung, cùng hash, không RESYNC", async () => {
    expect(OpenFeature.getClient("main").providerStatus).toBe("READY");
    const opens = transport.streamCalls.length;

    // DRAFT không vào snapshot — delta `flagAbsent`
    await call(request(s2.baseUrl).post("/internal/flags"))
      .send({ projectId, key: "i15-draft", flagType: "BOOLEAN" })
      .expect(201);
    await providerCaughtUp();

    const active = await createActiveFlag(s2.baseUrl, actorId, {
      projectId,
      key: "i15-a",
      flagType: "BOOLEAN",
    });
    const flagId = active.body.flag.id as string;
    const variants = active.body.flag.variants as { id: string }[];
    await providerCaughtUp();
    expect(changed).toContain("i15-a");

    const config = await envConfigOf(flagId);
    i15ConfigId = config.id;
    await call(
      request(s2.baseUrl).put(`/internal/flag-envs/${config.id}/rules`),
    )
      .send({
        lastKnownUpdatedAt: config.updatedAt.toISOString(),
        rules: [
          {
            ruleType: "USER_BASED",
            condition: { userIds: ["u1"] },
            serve: { kind: "variant", variantId: variants[0]?.id },
            priority: 0,
          },
        ],
      })
      .expect(200);
    await call(request(s2.baseUrl).patch(`/internal/flag-envs/${config.id}`))
      .send({ isEnabled: false })
      .expect(200);

    const session = await admin.rolloutSession.create({
      data: {
        projectId: projectId as string,
        environmentId: envId,
        flagEnvConfigId: config.id,
        workloadName: "checkout",
        rolloutScope: "FLAG_LEVEL",
        strategy: "CANARY",
        controlMode: "UDP_DRIVEN",
        status: "IN_PROGRESS",
        thresholds: {},
        stepPercent: 10,
        createdById: actorId,
      },
      select: { id: true },
    });
    await call(
      request(s2.baseUrl).post(`/internal/rollouts/${session.id}/track`),
    ).expect(200);
    await admin.rolloutSession.update({
      where: { id: session.id },
      data: { status: "DONE" },
    });

    await providerCaughtUp();
    expect(provider.trackedFlags).toContain("i15-a");

    // Flag ACTIVE thứ hai: delta nối entry vào CUỐI mảng còn `/sdk/config` sắp theo
    // key — phép so phải là so NỘI DUNG chuẩn hoá, không phải thứ tự mảng thô
    await createActiveFlag(s2.baseUrl, actorId, {
      projectId,
      key: "i15-0-first",
      flagType: "BOOLEAN",
    });
    const version = await providerCaughtUp();

    const cfg = await request(s2.baseUrl)
      .get("/sdk/config")
      .set("Authorization", `Bearer ${serverKey}`)
      .expect(200);
    expect(cfg.body.configVersion).toBe(version);
    const mine = store.snapshot;
    if (mine === undefined) throw new Error("provider chưa có cache");
    expect(normalizeSnapshot(mine)).toEqual(
      normalizeSnapshot({
        flags: cfg.body.flags,
        segments: cfg.body.segments,
        trackedFlags: cfg.body.trackedFlags,
      }),
    );
    expect(mine.flags).toHaveLength(2);
    expect(configHashOf(mine)).toBe(cfg.body.configHash);
    // Mọi thay đổi tới bằng delta trên CÙNG stream: không mở lại, không RESYNC
    expect(transport.streamCalls.length).toBe(opens);
  }, 90_000);
});

// ------------------------------------------------------------- I26

/** Chiếu kết quả của SDK xuống mặt phẳng OFREP (§13.3 I26) */
function visible(details: EvaluationDetails<FlagValue>): Evaluation {
  if (details.errorCode !== undefined) {
    return {
      reason: "ERROR",
      errorCode:
        details.errorCode === "FLAG_NOT_FOUND" ? "FLAG_NOT_FOUND" : "GENERAL",
    };
  }
  if (details.reason === "DISABLED") {
    return details.flagMetadata["archived"] === true
      ? { reason: "DISABLED", archived: true }
      : { reason: "DISABLED" };
  }
  return {
    reason: details.reason as Evaluation["reason"],
    value: details.value,
    ...(details.variant === undefined ? {} : { variant: details.variant }),
  };
}

async function ofrepAt(
  target: number,
  context: Record<string, unknown>,
): Promise<(OfrepSuccess | OfrepFailure)[]> {
  const deadline = Date.now() + 15_000;
  for (;;) {
    const bulk = await request(s2.baseUrl)
      .post("/ofrep/v1/evaluate/flags")
      .set("Authorization", `Bearer ${clientKey}`)
      .send({ context })
      .expect(200);
    if (bulk.body.metadata.configVersion === target) {
      return bulk.body.flags as (OfrepSuccess | OfrepFailure)[];
    }
    if (Date.now() > deadline) {
      throw new Error(`OFREP không đuổi kịp version ${String(target)}`);
    }
    await new Promise((r) => setTimeout(r, 100));
  }
}

describe("I26 — provider (local) và OFREP cho cùng kết quả", () => {
  it("cấu hình và context ngẫu nhiên qua route ghi thật", async () => {
    const { ruleArb, contextArb, toServe } = i26Arbitraries([
      SEG_PRO,
      SEG_USERS,
    ]);
    const client = OpenFeature.getClient("main");
    const seen = new Set<string>();
    let run = 0;
    await fc.assert(
      fc.asyncProperty(
        fc.boolean(),
        fc.constantFrom("targetingKey", "orgId"),
        fc.array(ruleArb, { maxLength: 4 }),
        fc.array(contextArb, { minLength: 4, maxLength: 8 }),
        async (enabled, stickiness, rules, contexts) => {
          run += 1;
          const key = `i26p-${String(run)}-${randomUUID().slice(0, 6)}`;
          const flag = await createActiveFlag(s2.baseUrl, actorId, {
            projectId,
            key,
            flagType: "STRING",
            variants: [
              { key: "a", value: "A" },
              { key: "b", value: "B" },
              { key: "c", value: "C" },
            ],
            defaultVariantKey: "a",
          });
          const flagId = flag.body.flag.id as string;
          if (stickiness !== "targetingKey") {
            await call(request(s2.baseUrl).patch(`/internal/flags/${flagId}`))
              .send({
                lastKnownUpdatedAt: flag.body.flag.updatedAt as string,
                stickinessAttribute: stickiness,
              })
              .expect(200);
          }
          const ids = Object.fromEntries(
            (flag.body.flag.variants as { id: string; key: string }[]).map(
              (v) => [v.key, v.id],
            ),
          );
          const config = await envConfigOf(flagId);
          await call(
            request(s2.baseUrl).put(`/internal/flag-envs/${config.id}/rules`),
          )
            .send({
              lastKnownUpdatedAt: config.updatedAt.toISOString(),
              rules: rules.map((r, i) => ({
                ruleType: r.ruleType,
                condition: r.condition,
                serve: toServe(r.serve, ids),
                priority: i,
              })),
            })
            .expect(200);
          await call(
            request(s2.baseUrl).patch(`/internal/flag-envs/${config.id}`),
          )
            .send({ isEnabled: enabled })
            .expect(200);

          const target = await providerCaughtUp();
          for (const context of contexts) {
            const mine = visible(
              await client.getStringDetails(key, "code-default", context),
            );
            const item = (await ofrepAt(target, context)).find(
              (f) => f.key === key,
            );
            if (item === undefined) throw new Error(`OFREP thiếu flag ${key}`);
            expect(mine).toEqual(fromOfrep(item));
            seen.add(mine.reason);
          }
        },
      ),
      { numRuns: 8, examples: I26_EXAMPLES, endOnFailure: true },
    );
    for (const reason of ["TARGETING_MATCH", "SPLIT", "DEFAULT", "DISABLED"]) {
      expect(seen).toContain(reason);
    }
  }, 180_000);
});

// ------------------------------------------------------------- mất quyền, mất server

/**
 * Ghi sự kiện của một client TỪ BÂY GIỜ. SDK gọi handler ngay lúc đăng ký nếu
 * provider đang ở đúng trạng thái đó (READY) — lần gọi ấy không phải sự kiện mới.
 */
async function recordEvents(domain: string): Promise<string[]> {
  const client = OpenFeature.getClient(domain);
  const events: string[] = [];
  for (const [event, name] of [
    [ProviderEvents.Ready, "ready"],
    [ProviderEvents.Error, "error"],
    [ProviderEvents.Stale, "stale"],
  ] as const) {
    client.addHandler(event, () => events.push(name));
  }
  await new Promise((r) => setTimeout(r, 0));
  events.length = 0;
  return events;
}

describe("fail-static", () => {
  it("khoá bị thu hồi ⇒ ERROR, vẫn phục vụ cấu hình cuối (stale); khôi phục ⇒ READY", async () => {
    const client = OpenFeature.getClient("main");
    const before = await client.getBooleanDetails("i15-a", true);
    const events = await recordEvents("main");
    const revoke = (revokedAt: Date | null) =>
      admin.sdkKey.updateMany({
        where: { environmentId: envId, keyType: "SERVER" },
        data: { revokedAt },
      });

    await revoke(new Date());
    // Hub SSE đóng stream của khoá thu hồi trong ≤ SSE.revocationCheckMs
    await waitFor(() => events.includes("error"), 20_000);
    expect(await client.getBooleanDetails("i15-a", true)).toMatchObject({
      value: before.value,
      reason: before.reason,
      flagMetadata: { stale: true },
    });

    await revoke(null);
    await waitFor(() => events.includes("ready"), 20_000);
    expect(events).toEqual(["error", "ready"]);
    expect(
      (await client.getBooleanDetails("i15-a", true)).flagMetadata["stale"],
    ).toBeUndefined();
  }, 60_000);

  it("I34: Service 2 chết ⇒ STALE, vẫn phục vụ; sống lại ⇒ READY và HỘI TỤ về cấu hình mới", async () => {
    const shortLived = createProviderForTesting(
      { host: s2.baseUrl, sdkKey: serverKey, pollingIntervalMs: 1_000 },
      // Dưới sàn của option công khai (nhịp tim 50 giây) — chỉ test mới hạ
      { sync: { backoffMinMs: 100, staleAfterMs: 1_000, staleCheckMs: 100 } },
    );
    await OpenFeature.setProviderAndWait("i34", shortLived);
    const client = OpenFeature.getClient("i34");
    const before = await client.getBooleanDetails("i15-a", true);
    const events = await recordEvents("i34");

    await s2.stop();
    await waitFor(() => events.includes("stale"), 10_000);
    expect(await client.getBooleanDetails("i15-a", true)).toMatchObject({
      value: before.value,
      reason: before.reason,
      flagMetadata: { stale: true },
    });

    await s2.start();
    await waitFor(() => events.includes("ready"), 30_000);
    expect(events.slice(0, 2)).toEqual(["stale", "ready"]);
    expect(events).not.toContain("error");
    expect((await client.getBooleanDetails("i15-a", true)).value).toBe(
      before.value,
    );

    // Hội tụ: một thay đổi SAU khi hồi phục tới provider qua stream mới
    expect(before.reason).toBe("DISABLED");
    await call(request(s2.baseUrl).patch(`/internal/flag-envs/${i15ConfigId}`))
      .send({ isEnabled: true })
      .expect(200);
    const target = await dbVersion();
    await waitFor(() => shortLived.configVersion === target, 15_000);
    expect((await client.getBooleanDetails("i15-a", true)).reason).toBe(
      "DEFAULT",
    );
  }, 90_000);
});
