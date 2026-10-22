import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { env } from "@udp/config";
import { createPrismaClient } from "@udp/db";
import { fromOfrep } from "@udp/flag-evaluator";
import type { OfrepFailure, OfrepSuccess } from "@udp/shared-types";
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
import { waitFor } from "./helpers/wait.js";

/**
 * [v4.11, Plan #47] Provider PYTHON với Service 2 THẬT — phép kiểm chéo ngôn ngữ của §6.8
 * ("máy trạng thái, tuỳ chọn, mặc định và ngữ nghĩa fail-static giống hệt"):
 *   - I15c: cache Python dựng bằng DELTA trên một stream (không RESYNC) trùng hash của
 *     `/sdk/config` cùng version;
 *   - I26: `get_string_details` của SDK OpenFeature Python và OFREP của Service 2 cho cùng kết
 *     quả trên cấu hình và context ngẫu nhiên qua route ghi thật.
 *
 * Provider Python chạy ở tiến trình con (`sdks/python/tests/fixtures/parity_driver.py`), hỏi đáp
 * qua stdin/stdout. Cần môi trường ảo `sdks/python/.venv` (CI dựng ở bước riêng) hoặc
 * `UDP_PYTHON`; không có thì bỏ qua — và báo rõ trong danh sách test bị bỏ qua.
 */

const here = dirname(fileURLToPath(import.meta.url));
const PY_ROOT = resolve(here, "../../../sdks/python");
const PYTHON =
  process.env["UDP_PYTHON"] ??
  [
    join(PY_ROOT, ".venv", "Scripts", "python.exe"),
    join(PY_ROOT, ".venv", "bin", "python"),
  ].find((p) => existsSync(p));

const admin = createPrismaClient({
  connectionString: env.DATABASE_URL_DIRECT,
  max: 3,
  cacheKey: `__udp_prisma_python_parity_${randomUUID()}`,
});
const SEG_PRO = randomUUID();
const SEG_USERS = randomUUID();

let s2: RunningService | undefined;
let child: ChildProcess | undefined;
let actorId: string;
let projectId: string | undefined;
let envId: string;
let serverKey: string;
let clientKey: string;
const pending: ((line: string) => void)[] = [];

/** Một câu hỏi, một dòng trả lời — tiến trình con trả lời tuần tự */
function ask<T>(command: Record<string, unknown>): Promise<T> {
  return new Promise<T>((resolveReply, reject) => {
    const timer = setTimeout(() => {
      reject(
        new Error(`provider Python không trả lời ${String(command["op"])}`),
      );
    }, 30_000);
    pending.push((line) => {
      clearTimeout(timer);
      resolveReply(JSON.parse(line) as T);
    });
    child?.stdin?.write(`${JSON.stringify(command)}\n`);
  });
}

interface PythonState {
  version: number | null;
  hash: string | null;
  streamOpens: number;
  tracked: string[];
}

describe.skipIf(PYTHON === undefined)(
  "provider Python với Service 2 thật (I15c, I26 chéo ngôn ngữ)",
  () => {
    beforeAll(async () => {
      actorId = (await stableOwner(admin)).id;
      const suffix = randomUUID().slice(0, 8);
      const segments = i26SegmentConditions();
      const project = await admin.project.create({
        data: {
          ownerId: actorId,
          name: `python-parity-${suffix}`,
          creationMode: "CREATE_NEW",
          languageRuntime: "python",
          resourceQuota: {},
          environments: {
            create: [
              { name: "dev", rank: 0, k8sNamespace: `udp-py-${suffix}` },
            ],
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

      const proc = spawn(
        PYTHON as string,
        [
          join(PY_ROOT, "tests", "fixtures", "parity_driver.py"),
          s2.baseUrl,
          serverKey,
        ],
        {
          env: { ...process.env, PYTHONPATH: join(PY_ROOT, "src") },
          stdio: ["pipe", "pipe", "inherit"],
        },
      );
      child = proc;
      createInterface({ input: proc.stdout }).on("line", (line) => {
        pending.shift()?.(line);
      });
      const ready = await new Promise<{ ready: boolean }>(
        (resolveReady, reject) => {
          const timer = setTimeout(() => {
            reject(new Error("provider Python không READY"));
          }, 30_000);
          pending.push((line) => {
            clearTimeout(timer);
            resolveReady(JSON.parse(line) as { ready: boolean });
          });
          proc.on("exit", (code) => {
            reject(new Error(`provider Python thoát sớm (mã ${String(code)})`));
          });
        },
      );
      expect(ready.ready).toBe(true);
    }, 120_000);

    afterAll(async () => {
      try {
        if (child !== undefined && child.exitCode === null) {
          child.stdin?.write(`${JSON.stringify({ op: "quit" })}\n`);
          await new Promise((r) => child?.once("exit", r));
        }
        await s2?.stop();
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

    const base = (): string => (s2 as RunningService).baseUrl;
    const call = (req: request.Test) => internalCall(req, actorId);

    async function dbVersion(): Promise<number> {
      const { configVersion } = await admin.environment.findUniqueOrThrow({
        where: { id: envId },
        select: { configVersion: true },
      });
      return configVersion;
    }

    /** Provider Python đã áp ĐÚNG version hiện tại của database */
    async function pythonCaughtUp(): Promise<PythonState> {
      const target = await dbVersion();
      let state: PythonState | undefined;
      await waitFor(async () => {
        state = await ask<PythonState>({ op: "state" });
        return state.version === target;
      }, 15_000);
      return state as PythonState;
    }

    async function envConfigOf(flagId: string) {
      return admin.flagEnvConfig.findFirstOrThrow({
        where: { flagId, environmentId: envId },
        select: { id: true, updatedAt: true },
      });
    }

    it("I15c: chuỗi ghi thật ⇒ cache Python dựng bằng delta trùng hash /sdk/config, không RESYNC", async () => {
      const opens = (await ask<PythonState>({ op: "state" })).streamOpens;
      const active = await createActiveFlag(base(), actorId, {
        projectId,
        key: "py-i15-a",
        flagType: "BOOLEAN",
      });
      const flagId = active.body.flag.id as string;
      const variants = active.body.flag.variants as { id: string }[];
      const config = await envConfigOf(flagId);
      await call(request(base()).put(`/internal/flag-envs/${config.id}/rules`))
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
      await call(request(base()).patch(`/internal/flag-envs/${config.id}`))
        .send({ isEnabled: false })
        .expect(200);
      await createActiveFlag(base(), actorId, {
        projectId,
        key: "py-i15-0-first",
        flagType: "BOOLEAN",
      });
      const state = await pythonCaughtUp();

      const cfg = await request(base())
        .get("/sdk/config")
        .set("Authorization", `Bearer ${serverKey}`)
        .expect(200);
      expect(cfg.body.configVersion).toBe(state.version);
      expect(state.hash).toBe(cfg.body.configHash);
      expect(state.streamOpens).toBe(opens);
    }, 90_000);

    it("I26: get_string_details của Python và OFREP cho cùng kết quả", async () => {
      const { ruleArb, contextArb, toServe } = i26Arbitraries([
        SEG_PRO,
        SEG_USERS,
      ]);
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
            const key = `py-i26-${String(run)}-${randomUUID().slice(0, 6)}`;
            const flag = await createActiveFlag(base(), actorId, {
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
              await call(request(base()).patch(`/internal/flags/${flagId}`))
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
              request(base()).put(`/internal/flag-envs/${config.id}/rules`),
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
              request(base()).patch(`/internal/flag-envs/${config.id}`),
            )
              .send({ isEnabled: enabled })
              .expect(200);

            const target = (await pythonCaughtUp()).version as number;
            const mine = await ask<{ results: unknown[] }>({
              op: "eval",
              key,
              contexts,
            });
            for (const [i, context] of contexts.entries()) {
              const item = (await ofrepAt(target, context)).find(
                (f) => f.key === key,
              );
              if (item === undefined)
                throw new Error(`OFREP thiếu flag ${key}`);
              expect(mine.results[i]).toEqual(fromOfrep(item));
              seen.add((mine.results[i] as { reason: string }).reason);
            }
          },
        ),
        { numRuns: 6, examples: I26_EXAMPLES, endOnFailure: true },
      );
      for (const reason of [
        "TARGETING_MATCH",
        "SPLIT",
        "DEFAULT",
        "DISABLED",
      ]) {
        expect(seen).toContain(reason);
      }
    }, 240_000);

    async function ofrepAt(
      target: number,
      context: Record<string, unknown>,
    ): Promise<(OfrepSuccess | OfrepFailure)[]> {
      const deadline = Date.now() + 15_000;
      for (;;) {
        const bulk = await request(base())
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
  },
);
