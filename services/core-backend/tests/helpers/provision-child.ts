import { runFullProvision } from "@udp/adapter-core/contract";
import type { RunnerPhase } from "@udp/adapter-core/runner";
import { createSimAdapter, SimCloud } from "@udp/adapter-core/testing";
import { env } from "@udp/config";
import { writeSync } from "node:fs";
import { createPrismaClient } from "@udp/db";
import { createPrismaLedger } from "../../src/modules/provisioning/prisma-ledger.js";
import {
  CHILD_DONE,
  CHILD_FENCED,
  CHILD_GRACEFUL_EXIT,
  CHILD_PAUSED,
  type ChildRequest,
} from "./child-protocol.js";
import { createPrismaFence } from "../../src/modules/provisioning/provisioning-job.repository.js";

/**
 * [v4.10] Tiến trình con của lưới khôi phục TẦNG 2 — `kill -9` thật.
 *
 * Vì sao phải là một tiến trình riêng: bốn ô `child-only` (K3, K6, K9, K10) khẳng định
 * tính chất của **một tiến trình thật đã chết**. Ném một exception in-process không phải
 * cùng một thứ — `finally` vẫn chạy, buffer vẫn flush, `PrismaClient` vẫn `$disconnect`,
 * và transaction đang mở vẫn được rollback tử tế. Đúng những thứ đó là cái mà `kill -9`
 * KHÔNG cho, và là cái mà mọi lập luận về khôi phục phải chịu được.
 *
 * Nên tiến trình này **tự bắn vào đầu mình** bằng `SIGKILL` tại đúng pha được chỉ định.
 * `process.kill(process.pid, "SIGKILL")` không bắt được, không có handler nào chạy, không
 * có gì được dọn — kể cả session Postgres đang mở (xem N10 ở phía tiến trình cha).
 *
 * `application_name` riêng cho mỗi lượt: sau khi con chết, cha tìm session còn sót theo
 * tên đó trong `pg_stat_activity`. Không có tên riêng thì không phân biệt được session
 * của con đã chết với session của chính tiến trình test.
 */

function connectionWithAppName(name: string): string {
  const url = new URL(env.DATABASE_URL_S1);
  url.searchParams.set("application_name", name);
  return url.toString();
}

/**
 * Mốc "tôi thoát tử tế" — xem `CHILD_GRACEFUL_EXIT` về vì sao nó phải tồn tại.
 *
 * `writeSync` chứ không `process.stdout.write`: trong handler `exit`, đường ghi bất đồng
 * bộ không kịp flush, nên mốc sẽ mất và phép khẳng định lại không phân biệt được gì.
 */
process.on("exit", () => {
  writeSync(
    1,
    `${CHILD_GRACEFUL_EXIT}
`,
  );
});

async function main(): Promise<void> {
  const raw = process.argv[2];
  if (raw === undefined) throw new Error("thiếu tham số JSON");
  const req = JSON.parse(raw) as ChildRequest;

  const cloud = new SimCloud({ statePath: req.cloudStatePath });
  if (req.tagPropagationDelayMs !== undefined) {
    await cloud.setTagPropagationDelay(req.tagPropagationDelayMs);
  }
  const adapter = createSimAdapter({ cloud, lookupBy: "tag" });

  const prisma = createPrismaClient({
    connectionString: connectionWithAppName(req.applicationName),
    max: 2,
    cacheKey: `__udp_child_${req.applicationName}`,
  });
  const ledger = createPrismaLedger({ prisma, jobId: req.jobId });
  const fence = createPrismaFence(prisma, {
    jobId: req.jobId,
    workerId: req.workerId,
    version: req.version,
    claimedUntil: new Date(Date.now() + 600_000),
  });

  let fired = false;
  const observer = {
    onPhase: async (phase: RunnerPhase, stepName: string): Promise<void> => {
      if (fired) return;
      if (req.crashPhase === undefined || phase !== req.crashPhase) return;
      if (req.crashStep !== undefined && stepName !== req.crashStep) return;
      fired = true;

      if (req.mode === "pause") {
        process.stdout.write(`${CHILD_PAUSED}\n`);
        await new Promise<void>((resolve) => {
          process.stdin.once("data", () => resolve());
        });
        return;
      }
      /**
       * KHÔNG `process.exit`, KHÔNG ném: cả hai đều cho `finally` và các handler chạy.
       * `SIGKILL` vào chính mình là cách duy nhất mô phỏng đúng một tiến trình bị hạ.
       */
      process.kill(process.pid, "SIGKILL");
      /** Không tới được; để phòng trường hợp nền tảng bỏ qua tín hiệu */
      await new Promise<void>(() => undefined);
    },
  };

  try {
    const outcomes = await runFullProvision({
      adapter,
      ledger,
      observer,
      fence,
    });
    process.stdout.write(
      `${CHILD_DONE} ${JSON.stringify(outcomes.map((o) => o.status))}\n`,
    );
  } catch (err) {
    const name = err instanceof Error ? err.name : "";
    if (name === "FenceLostError") {
      process.stdout.write(`${CHILD_FENCED}\n`);
      await prisma.$disconnect();
      process.exit(0);
    }
    throw err;
  }
  await prisma.$disconnect();
  process.exit(0);
}

await main();
