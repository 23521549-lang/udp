import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  CONTRACT_PROJECT,
  measureConvergence,
  runFullProvision,
  type CloudContractEnv,
} from "@udp/adapter-core/contract";
import type { RunnerPhase } from "@udp/adapter-core/runner";
import { SecretBuffer, type ResolvedCredential } from "@udp/adapter-core";
import {
  CLOUD_FIXTURE,
  createSimAdapter,
  SimCloud,
} from "@udp/adapter-core/testing";
import { env } from "@udp/config";
import type { PrismaClient } from "@udp/db";
import { rebuildLedger } from "../../src/modules/provisioning/ledger-rebuild.js";
import { createPrismaLedger } from "../../src/modules/provisioning/prisma-ledger.js";
import {
  claim,
  createPrismaFence,
  release,
  type JobLease,
} from "../../src/modules/provisioning/provisioning-job.repository.js";
import {
  CHILD_DONE,
  CHILD_FENCED,
  CHILD_GRACEFUL_EXIT,
  CHILD_PAUSED,
  type ChildRequest,
} from "./child-protocol.js";

/**
 * [v4.10] Driver của lưới khôi phục TẦNG 2.
 *
 * Tầng 1 chạy 91 ô in-process với sổ trong bộ nhớ, và nó bắt lỗi phụ thuộc vị trí rất
 * tốt. Nhưng bốn ô `child-only` (K3, K6, K9, K10) khẳng định tính chất của **sổ bền** hay
 * của **một tiến trình thật đã chết**, nên ở tầng 1 chúng sẽ xanh mà chứng minh một thứ
 * khác. Tầng này chạy chúng bằng `PrismaLedger` trên Postgres thật và bằng tiến trình con
 * tự `SIGKILL`.
 *
 * Ba thứ tầng này có mà tầng 1 không thể có:
 *
 *  1. **`kill -9` thật** — không `finally`, không flush, không `$disconnect`, transaction
 *     đang mở bị bỏ giữa đường. Mọi lập luận về khôi phục phải chịu được đúng cái đó.
 *  2. **Fence thật** — ô K9 cần một lease thật để mất. In-process không có gì để mất.
 *  3. **Sổ bền** — ô K10 xoá sạch bảng rồi đòi `rebuildLedgerFromCloud` hội tụ; với sổ
 *     trong bộ nhớ, "xoá sạch" và "dựng lại" là cùng một thao tác trên cùng một map.
 */

const CHILD_ENTRY = "tests/helpers/provision-child.ts";
const WORKER_PARENT = "worker-cha";

export interface ChildOutcome {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

/** Số session còn sót mang `application_name` này, sau khi cha đã dọn (N10) */
export interface SessionAudit {
  /** Thấy bao nhiêu session của con đã chết TRƯỚC khi dọn */
  leftBefore: number;
  /** Bao nhiêu session còn lại SAU khi dọn — phải là 0 */
  leftAfter: number;
}

/**
 * Chạy một tiến trình con tới khi nó chết hoặc xong.
 *
 * `stdin: "pipe"` vì ô K9 cần gửi một dòng cho con đi tiếp. `stdio` của stdout/stderr
 * cũng pipe để cha đọc được dấu hiệu `UDP_CHILD_*` — con bị `SIGKILL` thì những gì nó
 * chưa flush sẽ mất, và đó là đúng: một tiến trình bị hạ không kịp nói gì.
 */
export function spawnChild(
  req: ChildRequest,
  onPaused?: (write: (line: string) => void) => void,
): Promise<ChildOutcome> {
  return new Promise<ChildOutcome>((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["--import", "tsx", CHILD_ENTRY, JSON.stringify(req)],
      { cwd: process.cwd(), stdio: ["pipe", "pipe", "pipe"] },
    );
    let stdout = "";
    let stderr = "";
    let notified = false;

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
      if (
        !notified &&
        stdout.includes(CHILD_PAUSED) &&
        onPaused !== undefined
      ) {
        notified = true;
        onPaused((line) => child.stdin.write(`${line}\n`));
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code, signal) => {
      resolve({ code, signal, stdout, stderr });
    });
  });
}

/**
 * Con đã chết ĐỘT TỬ chưa — phát biểu theo tính chất, không theo tín hiệu.
 *
 * **Windows không có signal.** `process.kill(pid, "SIGKILL")` ở đó được Node dịch thành
 * `TerminateProcess`, và đó đúng là ngữ nghĩa cần: tiến trình bị hạ ngay, không handler
 * nào chạy, không `finally`, không flush. Nhưng `child.on("close")` báo
 * `code = 1, signal = null` chứ không phải `signal = "SIGKILL"` (đã đo trên máy này).
 * Trên Linux của CI thì ngược lại.
 *
 * Nên khẳng định theo tín hiệu là khẳng định một chi tiết nền tảng, và nó sẽ đỏ ở đúng
 * một trong hai nơi. Tính chất THẬT cần khẳng định là hai điều, và cả hai độc lập nền
 * tảng: con **không in** `CHILD_DONE` (nó chưa chạy xong), và nó **không thoát 0** (nó
 * không tự kết thúc tử tế).
 */
export function assertDiedAbruptly(child: ChildOutcome, label: string): void {
  if (child.stdout.includes(CHILD_DONE)) {
    throw new Error(`${label}: con chạy XONG, không chết như ô này cần`);
  }
  if (child.code === 0) {
    throw new Error(
      `${label}: con thoát 0, tức nó thoát tử tế chứ không bị hạ`,
    );
  }
  /**
   * Mốc quyết định: tiến trình thoát tử tế thì `process.on("exit")` chạy và in mốc đó.
   * `SIGKILL` (và `TerminateProcess`) không cho handler nào chạy, nên mốc PHẢI vắng.
   */
  if (child.stdout.includes(CHILD_GRACEFUL_EXIT)) {
    throw new Error(
      `${label}: con thoát TỬ TẾ (handler exit đã chạy), không phải bị hạ`,
    );
  }
  const abrupt =
    child.signal === "SIGKILL" ||
    (process.platform === "win32" && child.code !== null);
  if (!abrupt) {
    throw new Error(
      `${label}: chết không đúng hình — code=${String(child.code)}, ` +
        `signal=${String(child.signal)}, stderr=${child.stderr.slice(0, 400)}`,
    );
  }
}

/**
 * N10 — session của tiến trình đã chết không được giữ khoá cho ô sau.
 *
 * `kill -9` không đóng kết nối tử tế, nên phía Postgres vẫn còn một backend cho tới khi
 * nó nhận ra TCP đã đứt. R24-9 đo được 727 ms / 449 ms và **0 session còn sót**, nên
 * thực tế nó tự dọn nhanh. Nhưng "thực tế nhanh" không phải một bảo đảm: cha dọn tường
 * minh theo `application_name` rồi KHẲNG ĐỊNH bằng `pg_stat_activity`. Không có bước
 * khẳng định thì một ô sau đó treo vì khoá sẽ trông như một lỗi của chính nó.
 */
export async function auditSessions(
  admin: PrismaClient,
  applicationName: string,
): Promise<SessionAudit> {
  const before = await admin.$queryRaw<{ pid: number }[]>`
    SELECT pid FROM pg_stat_activity
     WHERE application_name = ${applicationName} AND pid <> pg_backend_pid()`;
  for (const row of before) {
    await admin.$queryRaw`SELECT pg_terminate_backend(${row.pid})`;
  }
  const after = await admin.$queryRaw<{ pid: number }[]>`
    SELECT pid FROM pg_stat_activity
     WHERE application_name = ${applicationName} AND pid <> pg_backend_pid()`;
  return { leftBefore: before.length, leftAfter: after.length };
}

/**
 * Ép hạn lease của một người giữ ĐÃ CÓ BẰNG CHỨNG là chết — chỉ dùng trong test.
 *
 * Hàm này **không** có mặt trong `src/`, và đó là chủ ý. Trong sản phẩm, lease tự hết hạn
 * ở `claimed_until` và pg-boss là thứ giao job lại; không có đường nào để một worker cướp
 * lease của worker khác, vì có đường đó là có cách vượt qua fencing. Ở đây tiến trình cha
 * chỉ **tăng tốc cái đồng hồ**: nó đã có hai bằng chứng người giữ không còn (tiến trình
 * con đã thoát, và `auditSessions` đã xác nhận session của nó sạch), nên chờ đủ 600 giây
 * chỉ làm lưới chậm chứ không chứng minh thêm gì.
 *
 * `version` tăng một: nếu con sống lại được thì token của nó hết giá trị, đúng như khi
 * pg-boss giao job cho worker khác.
 */
export async function expireDeadLease(
  admin: PrismaClient,
  jobId: string,
  deadHolder: string,
): Promise<void> {
  const { count } = await admin.provisioningJob.updateMany({
    where: { id: jobId, claimedBy: deadHolder },
    data: { claimedUntil: new Date(0), version: { increment: 1 } },
  });
  if (count !== 1) {
    throw new Error(
      `không ép được hạn lease của ${deadHolder} trên job ${jobId}`,
    );
  }
}

export interface Tier2Context {
  /** Client owner — dùng để dựng tiền đề và để dọn, KHÔNG phải đường ghi của sổ */
  admin: PrismaClient;
  /** Client `udp_s1` — đường ghi thật của sổ */
  s1: PrismaClient;
  jobId: string;
}

/**
 * Mot o cua tang 2.
 *
 * `name` va `crashId` co mat de thong diep loi tu noi duoc no thuoc o nao: mot loi
 * "khong gianh duoc lease" khong kem ten o thi doc 40 dong log de doan xem o nao.
 */
export interface Tier2Cell {
  name: string;
  crashId: string;
  stepName: string;
  phase: RunnerPhase;
  mode: "kill" | "pause";
}

export interface Tier2Result {
  child: ChildOutcome;
  sessions: SessionAudit;
  /** Thời gian tường của cả ô, để chốt trần theo QĐ-23 */
  elapsedMs: number;
}

/** Một thư mục tạm cho state của cloud mô phỏng; mỗi ô một thư mục */
export function freshCloud(): {
  cloud: SimCloud;
  path: string;
  dispose: () => void;
} {
  const dir = mkdtempSync(join(tmpdir(), "grid2-"));
  const path = join(dir, "cloud.json");
  return {
    cloud: new SimCloud({ statePath: path }),
    path,
    dispose: () => rmSync(dir, { recursive: true, force: true }),
  };
}

export function envFor(
  cloud: SimCloud,
  s1: PrismaClient,
  jobId: string,
): CloudContractEnv {
  return {
    driver: "child-process",
    ledger: () => createPrismaLedger({ prisma: s1, jobId }),
    control: cloud,
    fixture: CLOUD_FIXTURE,
  };
}

/**
 * Xoá sạch hàng sổ của project hợp đồng, KÈM hàng audit của nó.
 *
 * Audit phải xoá cùng, và không phải cho gọn: `audit_logs.project_id` là khoá ngoại với
 * `onDelete: Restrict`, nên một hàng audit còn sót làm cả `afterAll` vỡ ở
 * `project.deleteMany` — đã thấy đúng hình dạng đó, 42 ô bị bỏ qua vì `beforeAll` không
 * chạy nổi. Đi bằng `admin` vì `udp_s1` chỉ có SELECT và INSERT trên `audit_logs`, và
 * đúng như vậy: một đường xoá audit trong mã sản phẩm là một lỗ hổng.
 */
export async function wipeRows(admin: PrismaClient): Promise<void> {
  await admin.auditLog.deleteMany({ where: { projectId: CONTRACT_PROJECT } });
  await admin.provisionedResource.deleteMany({
    where: { projectId: CONTRACT_PROJECT },
  });
}

/**
 * Một ô `kill`: con chạy tới pha rồi tự `SIGKILL`, cha dọn session rồi tiếp tục.
 *
 * Cha KHÔNG dùng lại fence token của con: nó `claim()` lại, nên `version` tăng và token
 * của con (nếu con còn sống) hết giá trị. Đó đúng là điều pg-boss làm khi giao job cho
 * worker khác, và nhờ vậy ô K9 không cần một cơ chế riêng.
 */
export async function runKillCell(args: {
  ctx: Tier2Context;
  cell: Tier2Cell;
  cloudPath: string;
  cloud: SimCloud;
}): Promise<Tier2Result> {
  const started = Date.now();
  const { ctx, cell } = args;
  const applicationName = `udp-grid2-${randomUUID().slice(0, 8)}`;

  const leaseChild = await claimOrThrow(ctx, "worker-con", cell.name);
  const child = await spawnChild({
    projectId: CONTRACT_PROJECT,
    jobId: ctx.jobId,
    workerId: leaseChild.workerId,
    version: leaseChild.version,
    cloudStatePath: args.cloudPath,
    applicationName,
    crashPhase: cell.phase,
    crashStep: cell.stepName,
    mode: cell.mode,
  });
  const sessions = await auditSessions(ctx.admin, applicationName);
  /**
   * Hai bằng chứng đã có (tiến trình thoát, session sạch), nên tăng tốc đồng hồ lease —
   * xem `expireDeadLease` về vì sao hàm đó không nằm trong `src/`.
   */
  await expireDeadLease(ctx.admin, ctx.jobId, leaseChild.workerId);

  return { child, sessions, elapsedMs: Date.now() - started };
}

/**
 * Ô `perturb` (K7, K8): không ai chết — KHÁCH sửa tài nguyên ngoài luồng.
 *
 * Ở tầng 2 nó chạy trên `PrismaLedger`, và đó không phải sự lặp lại của tầng 1: cạnh
 * `READY → CREATING` của D-30 phải đi được trên máy trạng thái cưỡng chế bởi Postgres,
 * không chỉ trên một map trong bộ nhớ. Một cạnh thiếu trong enum hay trong
 * `LEDGER_TRANSITIONS` chỉ lộ ra ở đây.
 */
export async function runPerturbCell(args: {
  ctx: Tier2Context;
  cloud: SimCloud;
  perturb: (cloud: SimCloud) => Promise<void>;
  label: string;
}): Promise<{ elapsedMs: number; attempts: number }> {
  const started = Date.now();
  const first = await resumeUntilConverged({
    ctx: args.ctx,
    cloud: args.cloud,
  });
  if (!(first.statuses.at(-1) ?? []).every((s) => s === "SUCCESS")) {
    throw new Error(
      `${args.label}: lượt đầu chưa xong: ${JSON.stringify(first.statuses)}`,
    );
  }
  await args.perturb(args.cloud);
  const second = await resumeUntilConverged({
    ctx: args.ctx,
    cloud: args.cloud,
  });
  if (!(second.statuses.at(-1) ?? []).every((s) => s === "SUCCESS")) {
    throw new Error(
      `${args.label}: lượt sau chưa hội tụ: ${JSON.stringify(second.statuses)}`,
    );
  }
  return { elapsedMs: Date.now() - started, attempts: second.attempts };
}

/**
 * Ô K9 — worker cũ CÒN SỐNG và bị fencing chặn.
 *
 * Đây là ô duy nhất không giết con: giết nó thì không còn ai để bị chặn, và ô đó sẽ xanh
 * vì "không có worker nào tạo tài nguyên thứ hai" chứ không vì cơ chế chặn hoạt động.
 * Con dừng giữa đường với token cũ trong tay, cha cướp job (đúng như pg-boss giao lại),
 * rồi con đi tiếp và phải vỡ ở lần `assert()` kế tiếp.
 */
export async function runFenceCell(args: {
  ctx: Tier2Context;
  cloudPath: string;
  phase: RunnerPhase;
  stepName: string;
}): Promise<{ child: ChildOutcome; elapsedMs: number }> {
  const started = Date.now();
  const { ctx } = args;
  const applicationName = `udp-grid2-k9-${randomUUID().slice(0, 8)}`;
  const leaseChild = await claimOrThrow(ctx, "worker-con-k9");

  const child = await spawnChild(
    {
      projectId: CONTRACT_PROJECT,
      jobId: ctx.jobId,
      workerId: leaseChild.workerId,
      version: leaseChild.version,
      cloudStatePath: args.cloudPath,
      applicationName,
      crashPhase: args.phase,
      crashStep: args.stepName,
      mode: "pause",
    },
    (write) => {
      /**
       * Con đang dừng. Cha cướp lease TRƯỚC khi cho con đi tiếp — thứ tự này là toàn bộ
       * nội dung của ô: đảo lại thì con chạy xong trước khi mất quyền, và không có gì
       * bị chặn.
       */
      void (async () => {
        await expireDeadLease(ctx.admin, ctx.jobId, leaseChild.workerId);
        const stolen = await claimOrThrow(ctx, "worker-cha-k9");
        /**
         * NHẢ ngay sau khi cướp.
         *
         * Việc của lần `claim` này chỉ là đẩy `version` lên để token của con hết giá
         * trị; giữ tiếp thì lượt chạy lại của chính cha khóa chính nó — đã thấy đúng
         * hình dạng đó: "không giành được lease cho worker-cha-1" ở ngay ô sau.
         */
        await release(ctx.s1, stolen);
        write("di-tiep");
      })();
    },
  );
  return { child, elapsedMs: Date.now() - started };
}

/**
 * Ô K10 — mất sổ, dựng lại TỪ CLOUD.
 *
 * `variant` quyết định mất tới đâu, và hai biến thể khác nhau ở đúng chỗ khó:
 *
 *  - `a`: mất `provisioned_resources`, job cũ còn ⇒ nối lại, lịch sử nguyên vẹn.
 *  - `b`: mất cả `provisioning_jobs` ⇒ phải tạo job tổng hợp CÓ ĐÁNH DẤU, vì `job_id` là
 *    cột duy nhất không suy được từ tag (ADR-08).
 */
export async function runRebuildCell(args: {
  ctx: Tier2Context;
  cloud: SimCloud;
  cloudPath: string;
  phase: RunnerPhase;
  stepName: string;
  variant: "a" | "b";
}): Promise<{
  child: ChildOutcome;
  sessions: SessionAudit;
  rebuild: Awaited<ReturnType<typeof rebuildLedger>>;
  jobId: string;
  elapsedMs: number;
}> {
  const started = Date.now();
  const { ctx } = args;
  const killed = await runKillCell({
    ctx,
    cell: {
      name: `K10${args.variant}@${args.stepName}`,
      crashId: `K10${args.variant}`,
      stepName: args.stepName,
      phase: args.phase,
      mode: "kill",
    },
    cloudPath: args.cloudPath,
    cloud: args.cloud,
  });

  /** Mất sổ: xoá sạch hàng. Với biến thể `b`, xoá luôn bảng job của project */
  await wipeRows(ctx.admin);
  let jobId: string | undefined = ctx.jobId;
  if (args.variant === "b") {
    await ctx.admin.provisioningJob.deleteMany({
      where: { projectId: CONTRACT_PROJECT },
    });
    jobId = undefined;
  }

  const rebuild = await rebuildLedger({
    prisma: ctx.s1,
    adapter: createSimAdapter({ cloud: args.cloud, lookupBy: "tag" }),
    credential: gridCredential(),
    projectId: CONTRACT_PROJECT,
    ...(jobId === undefined ? {} : { jobId }),
  });

  return {
    child: killed.child,
    sessions: killed.sessions,
    rebuild,
    jobId: rebuild.jobId,
    elapsedMs: Date.now() - started,
  };
}

/**
 * Credential cho các lời gọi adapter mà cha tự thực hiện.
 *
 * Nó là một `SecretBuffer` thật, không phải một chuỗi: `ResolvedCredential` có `dispose()`
 * và bị cấm serialize (I12, I24), nên dựng một object phẳng "cho nhanh" ở đây là dựng một
 * thứ khác hình với thứ mã sản phẩm nhận.
 */
export function gridCredential(): ResolvedCredential {
  const payload = new SecretBuffer("bi-mat-cua-luoi-tang-2");
  return {
    provider: "aws",
    mode: "BYOC",
    authKind: "AWS_ROLE",
    payload,
    expiresAt: new Date(Date.now() + 900_000),
    dispose: () => {
      payload.dispose();
    },
  };
}

export async function claimOrThrow(
  ctx: Tier2Context,
  workerId: string,
  cellName?: string,
): Promise<JobLease> {
  const lease = await claim({
    prisma: ctx.s1,
    jobId: ctx.jobId,
    workerId,
    leaseMs: 600_000,
  });
  if (lease === null) {
    /**
     * Thông điệp mang tên ô, vì đây là lỗi hay gặp nhất của driver và nó KHÔNG nói gì về
     * ô đang chạy nếu chỉ có tên worker: 40 ô đều dùng cùng một tên worker.
     */
    const where = cellName === undefined ? "" : ` (ô ${cellName})`;
    throw new Error(`không giành được lease cho ${workerId}${where}`);
  }
  return lease;
}

/**
 * Lượt chạy lại của cha, tới khi hội tụ hoặc hết lượt.
 *
 * Nhiều lượt vì một lần crash có thể để lại một hàng ở `CREATING` mà lượt sau mới tra
 * lại được (K2b), và vì compensation của lượt trước có thể phải chạy xong rồi mới tới
 * lượt tạo. Trần lượt là hữu hạn có chủ đích: "chạy lại tới khi xanh" thì một hiện thực
 * không hội tụ sẽ treo thay vì đỏ.
 */
export async function resumeUntilConverged(args: {
  ctx: Tier2Context;
  cloud: SimCloud;
  maxAttempts?: number;
}): Promise<{ attempts: number; statuses: string[][] }> {
  const { ctx, cloud } = args;
  const adapter = createSimAdapter({ cloud, lookupBy: "tag" });
  const max = args.maxAttempts ?? 3;
  const statuses: string[][] = [];

  for (let attempt = 1; attempt <= max; attempt += 1) {
    const lease = await claimOrThrow(
      ctx,
      `${WORKER_PARENT}-${String(attempt)}`,
    );
    const outcomes = await runFullProvision({
      adapter,
      ledger: createPrismaLedger({ prisma: ctx.s1, jobId: ctx.jobId }),
      observer: { onPhase: (): void => undefined },
      fence: createPrismaFence(ctx.s1, lease),
    });
    /**
     * NHẢ lease khi xong lượt — một worker thật làm đúng việc này.
     *
     * Không nhả thì job bị giữ tới hết `claimed_until`, và ô kế tiếp của lưới không giành
     * được lease: đã thấy đúng hình dạng đó, 37 trong 40 ô đỏ với "không giành được lease
     * cho worker-con" ngay sau ô đầu tiên xanh. Đó không phải lỗi của test mà là một
     * thiếu sót thật của đường đi: hoàn thành mà vẫn giữ lease nghĩa là project bị khoá
     * tới hết hạn lease dù không còn ai làm gì.
     */
    await release(ctx.s1, lease);
    statuses.push(outcomes.map((o) => o.status));
    if (outcomes.every((o) => o.status === "SUCCESS")) {
      return { attempts: attempt, statuses };
    }
  }
  return { attempts: max, statuses };
}

/** Ba khẳng định của I31 cộng chiều (d) — cùng hình với tầng 1, xem `grid.ts` */
export async function assertConverged(args: {
  ctx: Tier2Context;
  cloud: SimCloud;
  label: string;
}): Promise<void> {
  const cloudEnv = envFor(args.cloud, args.ctx.s1, args.ctx.jobId);
  const m = await measureConvergence({
    adapter: createSimAdapter({ cloud: args.cloud, lookupBy: "tag" }),
    ledger: cloudEnv.ledger(),
    env: cloudEnv,
  });
  const problems: string[] = [];
  if (m.rows.length !== CLOUD_FIXTURE.expectedResourceCount) {
    problems.push(
      `sổ có ${String(m.rows.length)} hàng, hằng số nói ` +
        `${String(CLOUD_FIXTURE.expectedResourceCount)}`,
    );
  }
  if (m.stuck.length > 0) {
    problems.push(
      `còn ${String(m.stuck.length)} hàng kẹt: ` +
        m.stuck.map((r) => `${r.kind}=${r.status}`).join(","),
    );
  }
  if (m.orphanOnCloud.length > 0) {
    problems.push(`cloud có mồ côi: ${m.orphanOnCloud.join(",")}`);
  }
  if (m.danglingRows.length > 0) {
    problems.push(`sổ trỏ tới id đã chết: ${m.danglingRows.join(",")}`);
  }
  if (problems.length > 0) {
    throw new Error(`${args.label}: ${problems.join(" | ")}`);
  }
}

/**
 * Re-export ba moc giao thuc de tep o khong phai nhap tu hai cho.
 *
 * KHONG re-export `env`: mot tep o lay `env` tu helper la mot mui chi sai huong - `env`
 * la cua `@udp/config`, va lay no qua day lam nguoi doc tuong helper co mot phan nao trong
 * cau hinh.
 */
export { CHILD_DONE, CHILD_FENCED, CHILD_PAUSED };
