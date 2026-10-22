import { randomUUID } from "node:crypto";
import { env } from "@udp/config";
import { createPrismaClient } from "@udp/db";
import {
  evaluate,
  fromOfrep,
  ofrepVisible,
  prepareSnapshot,
  type Snapshot,
} from "@udp/flag-evaluator";
import type { OfrepFailure, OfrepSuccess } from "@udp/shared-types";
import fc from "fast-check";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { changeFeedWatcher } from "../src/changefeed/index.js";
import {
  createActiveFlag,
  I26_EXAMPLES,
  i26Arbitraries,
  i26SegmentConditions,
  internalCall,
  newSdkKeyToken,
  sdkKeyData,
  stableOwner,
} from "@udp/test-support";

/**
 * **I26** (§13.3) [v4.6] — đường LOCAL (SDK dựng snapshot từ `/sdk/config` rồi
 * gọi lõi) và đường OFREP (khoá CLIENT) cho ra CÙNG kết quả, cho cấu hình và
 * context sinh ngẫu nhiên.
 *
 * Mặt phẳng so: `ofrepVisible(evaluate(local))` với `fromOfrep(ofrep)` — đúng các
 * trường dây OFREP mang (reason, value, variant, errorCode, archived). `ruleId`
 * và thông điệp lỗi không lên dây (I11), nên không nằm trong phép so.
 *
 * Cấu hình đi qua route GHI thật (có validate, có outbox, có hash); segment cố
 * định chèn trước khi S2 nạp cache (chưa có CRUD — #23). Chỉ so khi hai phía ở
 * CÙNG `configVersion` — cache SERVER và CLIENT làm mới độc lập.
 */

const app = createApp();
const admin = createPrismaClient({
  connectionString: env.DATABASE_URL_DIRECT,
  max: 3,
  cacheKey: `__udp_prisma_i26_${randomUUID()}`,
});
const SERVER_KEY = newSdkKeyToken("SERVER");
const CLIENT_KEY = newSdkKeyToken("CLIENT");
const SEG_PRO = randomUUID();
const SEG_USERS = randomUUID();
const segments = i26SegmentConditions();

let actorId: string;
let projectId: string | undefined;
let envId: string;

const internal = (req: request.Test): request.Test =>
  internalCall(req, actorId);

beforeAll(async () => {
  actorId = (await stableOwner(admin)).id;
  const suffix = randomUUID().slice(0, 8);
  const project = await admin.project.create({
    data: {
      ownerId: actorId,
      name: `i26-${suffix}`,
      creationMode: "CREATE_NEW",
      languageRuntime: "nodejs",
      resourceQuota: {},
      environments: {
        create: [{ name: "dev", rank: 0, k8sNamespace: `udp-i26-${suffix}` }],
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
  await admin.sdkKey.createMany({
    data: [
      { token: SERVER_KEY, keyType: "SERVER" as const },
      { token: CLIENT_KEY, keyType: "CLIENT" as const },
    ].map((k) =>
      sdkKeyData({
        ...k,
        environmentId: envId,
        createdById: actorId,
        label: "i26",
      }),
    ),
  });
}, 60_000);

afterAll(async () => {
  if (projectId !== undefined) {
    await admin.configChangeLog.deleteMany({ where: { environmentId: envId } });
    await admin.auditLog.deleteMany({ where: { projectId } });
    await admin.project.delete({ where: { id: projectId } });
  }
  await admin.$disconnect();
});

// ------------------------------------------------------------- bộ sinh

const { ruleArb, contextArb, toServe } = i26Arbitraries([SEG_PRO, SEG_USERS]);

// ------------------------------------------------------------- hai đường

async function freshVersion(): Promise<number> {
  const { configVersion } = await admin.environment.findUniqueOrThrow({
    where: { id: envId },
    select: { configVersion: true },
  });
  return configVersion;
}

/** `/sdk/config` (đường local) ở ĐÚNG version hiện tại của database */
async function localAt(target: number): Promise<Snapshot> {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    await changeFeedWatcher.tick();
    const cfg = await request(app)
      .get("/sdk/config")
      .set("Authorization", `Bearer ${SERVER_KEY}`)
      .expect(200);
    if (cfg.body.configVersion === target) return cfg.body as Snapshot;
  }
  throw new Error(`đường local không đuổi kịp version ${String(target)}`);
}

/** Bulk OFREP ở ĐÚNG version — cache CLIENT làm mới độc lập với cache SERVER */
async function ofrepAt(
  target: number,
  context: Record<string, unknown>,
): Promise<(OfrepSuccess | OfrepFailure)[]> {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const bulk = await request(app)
      .post("/ofrep/v1/evaluate/flags")
      .set("Authorization", `Bearer ${CLIENT_KEY}`)
      .send({ context })
      .expect(200);
    if (bulk.body.metadata.configVersion === target) {
      return bulk.body.flags as (OfrepSuccess | OfrepFailure)[];
    }
    await changeFeedWatcher.tick();
  }
  throw new Error(`OFREP không đuổi kịp version ${String(target)}`);
}

describe("I26 — local và OFREP cho cùng kết quả", () => {
  it("cấu hình và context ngẫu nhiên qua route ghi thật", async () => {
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
          const key = `i26-${String(run)}-${randomUUID().slice(0, 6)}`;
          const flag = await createActiveFlag(app, actorId, {
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
            await internal(request(app).patch(`/internal/flags/${flagId}`))
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

          const { id: configId, updatedAt } =
            await admin.flagEnvConfig.findFirstOrThrow({
              where: { flagId, environmentId: envId },
              select: { id: true, updatedAt: true },
            });
          await internal(
            request(app).put(`/internal/flag-envs/${configId}/rules`),
          )
            .send({
              lastKnownUpdatedAt: updatedAt.toISOString(),
              rules: rules.map((r, i) => ({
                ruleType: r.ruleType,
                condition: r.condition,
                serve: toServe(r.serve, ids),
                priority: i,
              })),
            })
            .expect(200);
          await internal(request(app).patch(`/internal/flag-envs/${configId}`))
            .send({ isEnabled: enabled })
            .expect(200);

          const target = await freshVersion();
          const local = prepareSnapshot(await localAt(target));
          for (const context of contexts) {
            const mine = ofrepVisible(evaluate(local, key, context));
            const item = (await ofrepAt(target, context)).find(
              (f) => f.key === key,
            );
            if (item === undefined) throw new Error(`OFREP thiếu flag ${key}`);
            expect(fromOfrep(item)).toEqual(mine);
            seen.add(mine.reason);
          }
        },
      ),
      {
        numRuns: 12,
        /**
         * Ví dụ cố định bảo đảm phép so đi qua MỌI nhánh bất kể seed — chốt "mỗi
         * reason xuất hiện" bên dưới không được đỏ vì may rủi. ERROR không sinh
         * được qua route GHI (validate chặn cấu hình hỏng); nhánh đó do fuzz I33
         * của lõi và test OFREP đảm nhận.
         */
        examples: I26_EXAMPLES,
        // Thu gọn phản ví dụ là thêm hàng chục lần ghi database — báo ngay
        endOnFailure: true,
      },
    );
    // Phép so không rỗng: mọi nhánh của lõi đã thật sự được đi qua
    for (const reason of ["TARGETING_MATCH", "SPLIT", "DEFAULT", "DISABLED"]) {
      expect(seen).toContain(reason);
    }
  }, 120_000);
});
