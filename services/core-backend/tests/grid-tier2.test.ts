import { existsSync, writeFileSync } from "node:fs";
import { CONTRACT_PROJECT } from "@udp/adapter-core/contract";
import type { RunnerPhase } from "@udp/adapter-core/runner";
import {
  CRASH_POINTS,
  FIXTURE_STEPS,
  K10_VARIANTS,
  SimCloud,
} from "@udp/adapter-core/testing";
import { env } from "@udp/config";
import { createPrismaClient, observeQueries, type PrismaClient } from "@udp/db";
import { stableOwner } from "@udp/test-support";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma as s1 } from "../src/core/db.js";
import { SYNTHETIC_JOB_MARKER } from "../src/modules/provisioning/ledger-rebuild.js";
import {
  assertConverged,
  assertDiedAbruptly,
  CHILD_FENCED,
  freshCloud,
  gridCredential,
  resumeUntilConverged,
  runFenceCell,
  runKillCell,
  runPerturbCell,
  runRebuildCell,
  wipeRows,
  type Tier2Context,
} from "./helpers/tier2.js";

/**
 * [v4.10] Lưới khôi phục TẦNG 2 — `PrismaLedger` trên Postgres thật, `kill -9` thật.
 *
 * Xem `helpers/tier2.ts` về ba thứ tầng này có mà tầng 1 không thể có. Tệp này liệt kê ô,
 * và số ô là con số **đo được rồi mới chốt** (QĐ-23): trần 8 phút, vượt trần thì tách
 * project vitest chứ không bỏ ô (N4).
 *
 * Mọi ô dùng CHUNG một project và một job, tuần tự, và mỗi ô xoá hàng sổ trước khi chạy.
 * Không phải để tiết kiệm: `idx_one_active_job_per_project` chỉ cho một job chưa kết thúc
 * trên mỗi project (ADR-02 — chặn bấm Provision hai lần), nên "một job cho mỗi ô" là một
 * thiết kế mà database từ chối, và lách nó bằng `state = 'DONE'` là bỏ đi chính cái ràng
 * buộc đang được bảo vệ.
 */

const admin: PrismaClient = createPrismaClient({
  connectionString: env.DATABASE_URL,
  max: 2,
  cacheKey: "__udp_prisma_grid2_admin",
});

const ctx: Tier2Context = { admin, s1, jobId: "" };

/** Mỗi ô báo lại thời gian của nó; meta-test cuối chốt tổng so với trần QĐ-23 */
const timings: { name: string; ms: number }[] = [];

function note(name: string, ms: number): void {
  timings.push({ name, ms });
}

async function ensureJob(): Promise<void> {
  const existing = await admin.provisioningJob.findFirst({
    where: { projectId: CONTRACT_PROJECT },
    select: { id: true },
  });
  if (existing !== null) {
    ctx.jobId = existing.id;
    return;
  }
  const job = await admin.provisioningJob.create({
    data: { projectId: CONTRACT_PROJECT, jobType: "PROVISION", payload: {} },
    select: { id: true },
  });
  ctx.jobId = job.id;
}

beforeAll(async () => {
  const owner = await stableOwner(admin);
  await wipeRows(admin);
  await admin.provisioningJob.deleteMany({
    where: { projectId: CONTRACT_PROJECT },
  });
  await admin.project.deleteMany({ where: { id: CONTRACT_PROJECT } });
  await admin.project.create({
    data: {
      id: CONTRACT_PROJECT,
      ownerId: owner.id,
      name: "luoi tang 2",
      creationMode: "CREATE_NEW",
      languageRuntime: "node20",
      resourceQuota: {},
    },
  });
  await ensureJob();
});

afterAll(async () => {
  await wipeRows(admin);
  await admin.provisioningJob.deleteMany({
    where: { projectId: CONTRACT_PROJECT },
  });
  await admin.project.deleteMany({ where: { id: CONTRACT_PROJECT } });
  await admin.$disconnect();
});

function phaseOf(id: string): RunnerPhase {
  const point = CRASH_POINTS.find((c) => c.id === id);
  if (point === undefined) throw new Error(`không có điểm crash ${id}`);
  return point.phase as RunnerPhase;
}

const KILL_POINTS = CRASH_POINTS.filter((c) => c.mode === "kill");
const PERTURB_POINTS = CRASH_POINTS.filter((c) => c.mode === "perturb");
/** Step đại diện cho nhóm "mỗi điểm crash một lượt": có `dependsOn`, không phải step đầu */
const REPRESENTATIVE_STEP = "subnet-a";

/**
 * Nhóm 1 — mỗi điểm crash `kill` đúng một lượt `kill -9` thật.
 *
 * K9 tách riêng ở dưới: nó cần worker cũ CÒN SỐNG, nên nó không thuộc nhóm này dù bảng
 * §4.5 xếp nó cùng chỗ.
 */
describe("tầng 2 — mỗi điểm crash một lượt kill -9", () => {
  for (const point of KILL_POINTS.filter((p) => p.id !== "K9" && p.id !== "K6")) {
    const label = `${point.id}@${REPRESENTATIVE_STEP}`;
    it(`${label}: ${point.why}`, async () => {
      const { cloud, path, dispose } = freshCloud();
      try {
        await wipeRows(admin);
        await ensureJob();
        const result = await runKillCell({
          ctx,
          cell: {
            name: label,
            crashId: point.id,
            stepName: REPRESENTATIVE_STEP,
            phase: point.phase as RunnerPhase,
            mode: "kill",
          },
          cloudPath: path,
          cloud,
        });
        assertDiedAbruptly(result.child, label);
        expect(result.sessions.leftAfter, "N10").toBe(0);

        const resumed = await resumeUntilConverged({ ctx, cloud });
        expect(
          resumed.statuses.at(-1)?.every((s) => s === "SUCCESS"),
          JSON.stringify(resumed.statuses),
        ).toBe(true);
        await assertConverged({ ctx, cloud, label });
        note(label, result.elapsedMs);
      } finally {
        dispose();
      }
    }, 120_000);
  }
});

/**
 * K6 tách riêng — pha `before-delete` **chỉ tồn tại khi có compensation**.
 *
 * Đây là một lỗi thật của bản đầu tiên, và nó đã đỏ đúng cách: `assertDiedAbruptly`
 * báo "con chạy XONG, không chết như ô này cần". Một lượt provision THÀNH CÔNG không
 * bao giờ đi qua `before-delete`, nên nhét K6 vào nhóm "mỗi điểm crash một lượt" là
 * tạo một ô không bao giờ nổ. Nếu `assertDiedAbruptly` chỉ xem `signal` thì ô này đã
 * xanh và chứng minh 0 thứ.
 *
 * Nên K6 phải bơm một lỗi cho một step ĐỨNG SAU để lượt chạy thất bại, compensation
 * bắt đầu, rồi con chết giữa đó.
 *
 * Thứ tự ngược của compensation (RUN8) KHÔNG được khẳng định ở đây và nói thẳng vì
 * sao: con chết ở `before-delete` của lần xoá ĐẦU TIÊN, nên nhật ký lời gọi của nó có
 * nhiều nhất một lần xoá — không đủ để nói gì về thứ tự. RUN8 có phép riêng trong
 * `runner.test.ts`. Ở đây ta khẳng định đúng thứ §4.5 đòi: **hội tụ**.
 */
describe("tầng 2 — K6 chết giữa compensation", () => {
  it("lượt sau vẫn hội tụ, không hàng nào kẹt và không tài nguyên nào rò", async () => {
    const { cloud, path, dispose } = freshCloud();
    try {
      await wipeRows(admin);
      await ensureJob();

      /**
       * `nat` thất bại vĩnh viễn ở lần gọi đầu: đủ muộn để có 5 tài nguyên phải dọn
       * ngược, và `permanent4xx` để runner không thử lại mà đi thẳng vào compensation.
       */
      await cloud.failNthCall("nat-gateway", 1, "permanent4xx");

      const result = await runKillCell({
        ctx,
        cell: {
          name: "K6@nat",
          crashId: "K6",
          stepName: "nat",
          phase: phaseOf("K6"),
          mode: "kill",
        },
        cloudPath: path,
        cloud,
      });
      assertDiedAbruptly(result.child, "K6@nat");
      expect(result.sessions.leftAfter, "N10").toBe(0);

      /** Lỗi đã tiêu thụ (n = 1), nên lượt cha đi được tới hết */
      const resumed = await resumeUntilConverged({ ctx, cloud });
      expect(
        resumed.statuses.at(-1)?.every((s) => s === "SUCCESS"),
        JSON.stringify(resumed.statuses),
      ).toBe(true);
      await assertConverged({ ctx, cloud, label: "K6@nat" });
      note("K6@nat", result.elapsedMs);
    } finally {
      dispose();
    }
  }, 120_000);
});

/**
 * Nhóm 2 — K3 và K10a trên MỌI step.
 *
 * Vì sao hai điểm này được nhân lên mà các điểm khác không: K3 là ô mà Terraform thua
 * (API đã trả về nhưng `provider_id` chưa ghi ⇒ phải `import` bằng tay), và K10a là ô
 * kiểm mệnh đề trung tâm của ADR-08. Cả hai phụ thuộc VỊ TRÍ: một step có `dependsOn` vỡ
 * khác một step độc lập, và step cuối của một bước khác step giữa.
 */
describe("tầng 2 — K3 trên mọi step", () => {
  for (const spec of FIXTURE_STEPS) {
    const label = `K3@${spec.name}`;
    it(label, async () => {
      const { cloud, path, dispose } = freshCloud();
      try {
        await wipeRows(admin);
        await ensureJob();
        const result = await runKillCell({
          ctx,
          cell: {
            name: label,
            crashId: "K3",
            stepName: spec.name,
            phase: phaseOf("K3"),
            mode: "kill",
          },
          cloudPath: path,
          cloud,
        });
        assertDiedAbruptly(result.child, label);
        expect(result.sessions.leftAfter, "N10").toBe(0);

        const resumed = await resumeUntilConverged({ ctx, cloud });
        expect(
          resumed.statuses.at(-1)?.every((s) => s === "SUCCESS"),
          JSON.stringify(resumed.statuses),
        ).toBe(true);
        await assertConverged({ ctx, cloud, label });
        note(label, result.elapsedMs);
      } finally {
        dispose();
      }
    }, 120_000);
  }
});

describe("tầng 2 — K10a trên mọi step", () => {
  for (const spec of FIXTURE_STEPS) {
    const label = `K10a@${spec.name}`;
    it(label, async () => {
      const { cloud, path, dispose } = freshCloud();
      try {
        await wipeRows(admin);
        await ensureJob();
        const result = await runRebuildCell({
          ctx,
          cloud,
          cloudPath: path,
          phase: phaseOf("K10"),
          stepName: spec.name,
          variant: "a",
        });
        assertDiedAbruptly(result.child, label);
        expect(result.sessions.leftAfter, "N10").toBe(0);

        /** Job cũ còn, nên sổ dựng lại nối vào chính nó — lịch sử nguyên vẹn */
        expect(result.rebuild.synthetic).toBe(false);
        expect(result.jobId).toBe(ctx.jobId);
        /** Mọi hàng dựng lại phải có `provider_id`: sổ là cache của cloud */
        expect(
          result.rebuild.rows.filter((r) => r.providerId === null),
        ).toEqual([]);

        const resumed = await resumeUntilConverged({ ctx, cloud });
        expect(
          resumed.statuses.at(-1)?.every((s) => s === "SUCCESS"),
          JSON.stringify(resumed.statuses),
        ).toBe(true);
        await assertConverged({ ctx, cloud, label });
        note(label, result.elapsedMs);
      } finally {
        dispose();
      }
    }, 120_000);
  }
});

/** Nhóm 3 — hai ô `perturb` trên sổ bền: cạnh `READY → CREATING` của D-30 */
describe("tầng 2 — khách sửa ngoài luồng", () => {
  for (const point of PERTURB_POINTS) {
    const label = `${point.id}@${REPRESENTATIVE_STEP}`;
    it(`${label}: ${point.why}`, async () => {
      const { cloud, dispose } = freshCloud();
      try {
        await wipeRows(admin);
        await ensureJob();
        const result = await runPerturbCell({
          ctx,
          cloud,
          label,
          perturb: async (c) => {
            const all = await c.listAll();
            const target = all.find(
              (r) => r.tags["udp.key"]?.endsWith(`:${REPRESENTATIVE_STEP}`) === true,
            );
            if (target === undefined) {
              throw new Error(`${label}: không tìm thấy tài nguyên để sửa`);
            }
            if (point.id === "K7") await c.deleteOutOfBand(target.id);
            else await c.removeTag(target.id, "udp.key");
          },
        });
        await assertConverged({ ctx, cloud, label });
        note(label, result.elapsedMs);
      } finally {
        dispose();
      }
    }, 120_000);
  }
});

/** Nhóm 4 — K9: worker cũ CÒN SỐNG, bị fencing chặn */
describe("tầng 2 — K9 fencing", () => {
  it("worker mất lease dừng lại, không tạo tài nguyên thứ hai", async () => {
    const { cloud, path, dispose } = freshCloud();
    try {
      await wipeRows(admin);
      await ensureJob();
      const result = await runFenceCell({
        ctx,
        cloudPath: path,
        phase: phaseOf("K9"),
        stepName: REPRESENTATIVE_STEP,
      });

      /** Con phải nói rõ nó bị chặn, không phải chết vì một lỗi khác */
      expect(result.child.stdout, result.child.stderr).toContain(CHILD_FENCED);

      /** Và cha vẫn hội tụ được sau đó */
      const resumed = await resumeUntilConverged({ ctx, cloud });
      expect(
        resumed.statuses.at(-1)?.every((s) => s === "SUCCESS"),
        JSON.stringify(resumed.statuses),
      ).toBe(true);
      await assertConverged({ ctx, cloud, label: "K9" });
      note("K9", result.elapsedMs);
    } finally {
      dispose();
    }
  }, 120_000);
});

/** Nhóm 5 — K10b: mất cả bảng job, phải tạo job tổng hợp CÓ ĐÁNH DẤU */
describe("tầng 2 — K10b mất cả bảng job", () => {
  it("job tổng hợp mang đánh dấu tường minh, không giả làm job thật", async () => {
    const { cloud, path, dispose } = freshCloud();
    try {
      await wipeRows(admin);
      await ensureJob();
      const result = await runRebuildCell({
        ctx,
        cloud,
        cloudPath: path,
        phase: phaseOf("K10"),
        stepName: REPRESENTATIVE_STEP,
        variant: "b",
      });
      assertDiedAbruptly(result.child, "K10b");
      expect(result.rebuild.synthetic).toBe(true);
      expect(result.jobId).not.toBe(ctx.jobId);

      /**
       * Đánh dấu phải NẰM TRONG DỮ LIỆU, đọc lại được.
       *
       * Không có nó, lịch sử không "mất" mà bị **bịa**: người đọc sổ sau này thấy 13 tài
       * nguyên thuộc một job chưa từng chạy, và không có gì nói rằng đó là suy đoán.
       */
      const job = await admin.provisioningJob.findUniqueOrThrow({
        where: { id: result.jobId },
        select: { payload: true, state: true },
      });
      const payload = job.payload as Record<string, unknown>;
      expect(Object.keys(payload)).toContain(SYNTHETIC_JOB_MARKER);
      expect(job.state).toBe("COMPENSATING");

      ctx.jobId = result.jobId;
      const resumed = await resumeUntilConverged({ ctx, cloud });
      expect(
        resumed.statuses.at(-1)?.every((s) => s === "SUCCESS"),
        JSON.stringify(resumed.statuses),
      ).toBe(true);
      await assertConverged({ ctx, cloud, label: "K10b" });
      note("K10b", result.elapsedMs);
    } finally {
      dispose();
    }
  }, 120_000);

  it("hai biến thể K10 đều có ô, và chúng là dữ liệu chứ không phải quy ước", () => {
    expect(K10_VARIANTS.map((v) => v.id)).toEqual(["K10a", "K10b"]);
  });
});

/**
 * Nhóm 6 — O-3: `rebuildLedgerFromCloud` KHÔNG đọc database.
 *
 * Đây là mệnh đề trung tâm của ADR-08 phát biểu ở dạng kiểm được: nguồn sự thật là cloud,
 * nên hàm dựng lại sổ phải sống được khi database **im lặng hoàn toàn**.
 *
 * Nói thẳng phạm vi: với adapter mô phỏng, nó gần như một tautology — adapter không nhận
 * `PrismaClient` nào cả, và phép kiểm biên của `design-lint` đã chặn `@udp/adapter-core`
 * phụ thuộc `@udp/db` ở mức package. Giá trị thật của ô này nằm ở chỗ nó đo **số truy
 * vấn** của hai đoạn tách rời nhau: lời gọi adapter phải là 0, còn đường GHI của Service 1
 * phải khác 0. Một hiện thực tương lai lén đọc sổ để "tăng tốc" sẽ làm con số đầu khác 0,
 * và đó là thứ một phép kiểm biên ở mức package không thấy.
 */
describe("tầng 2 — O-3: dựng lại sổ không đọc database", () => {
  it("lời gọi adapter phát 0 truy vấn, còn đường ghi thì khác 0", async () => {
    const { cloud, dispose } = freshCloud();
    try {
      await wipeRows(admin);
      await ensureJob();
      const resumed = await resumeUntilConverged({ ctx, cloud });
      expect(resumed.statuses.at(-1)?.every((s) => s === "SUCCESS")).toBe(true);

      const { createSimAdapter } = await import("@udp/adapter-core/testing");
      const adapter = createSimAdapter({ cloud, lookupBy: "tag" });

      let duringAdapter = 0;
      const stop = observeQueries(s1, () => {
        duringAdapter += 1;
      });
      const rebuilt = await adapter.rebuildLedgerFromCloud(
        gridCredential(),
        CONTRACT_PROJECT,
      );
      stop();
      expect(rebuilt.status).toBe("SUCCESS");
      expect(duringAdapter, "adapter KHÔNG được đọc database").toBe(0);

      let duringWrite = 0;
      const stop2 = observeQueries(s1, () => {
        duringWrite += 1;
      });
      const { rebuildLedger } = await import(
        "../src/modules/provisioning/ledger-rebuild.js"
      );
      await wipeRows(admin);
      await rebuildLedger({
        prisma: s1,
        adapter,
        credential: gridCredential(),
        projectId: CONTRACT_PROJECT,
        jobId: ctx.jobId,
      });
      stop2();
      expect(duringWrite, "đường GHI thì phải có truy vấn").toBeGreaterThan(0);
    } finally {
      dispose();
    }
  }, 120_000);
});

/**
 * Nhóm 7 — ô `indeterminate` (K2b) trên SỔ BỀN.
 *
 * Tầng 1 đã có ô này, và đây không phải bản sao: điều cần thấy ở tầng 2 là hàng giữ
 * `CREATING` **trong Postgres**, vì đó chính là thứ mà job quét 15 phút (`STALE_CREATING
 * _MINUTES`) tìm tới. Một hiện thục đẩy hàng sang `ORPHAN_SUSPECTED` ở đây sẽ làm step
 * bị khoá vĩnh viễn (trạng thái đó không có cạnh ra), và vỡ đúng yêu cầu (b) của I31.
 */
describe("tầng 2 — ô indeterminate trên sổ bền", () => {
  it("cửa sổ lan truyền tag ⇒ hàng giữ CREATING, không tạo trùng, lượt sau hội tụ", async () => {
    const started = Date.now();
    const { cloud, dispose } = freshCloud();
    try {
      await wipeRows(admin);
      await ensureJob();

      /** Cửa sổ rộng hơn tổng backoff: mọi lần tra trong lượt này đều bất định */
      await cloud.setTagPropagationDelay(3_600_000);
      await resumeUntilConverged({ ctx, cloud, maxAttempts: 1 });

      const stuck = await admin.provisionedResource.findMany({
        where: { projectId: CONTRACT_PROJECT },
        select: { status: true, providerId: true },
      });
      /**
       * Không hàng nào đi tới `ORPHAN_SUSPECTED` — đó là bản sửa D-3'.
       *
       * `indeterminate` là một lỗi TẠM ("chưa thấy"), không phải một kết luậ­n
       * ("không có"). Đẩy sang trạng thái cuối vì một blip mạng là khoá step vĩnh viễn.
       */
      expect(stuck.filter((r) => r.status === "ORPHAN_SUSPECTED")).toEqual([]);

      await cloud.setTagPropagationDelay(0);
      const second = await resumeUntilConverged({ ctx, cloud });
      expect(
        second.statuses.at(-1)?.every((x) => x === "SUCCESS"),
        JSON.stringify(second.statuses),
      ).toBe(true);
      await assertConverged({ ctx, cloud, label: "K2b" });
      note("K2b", Date.now() - started);
    } finally {
      dispose();
    }
  }, 120_000);
});

/**
 * Nhóm 8 — `.tmp` Bỏ LẠI THẬT sau `kill -9`.
 *
 * R24-6 đo được: `kill -9` đúng giữa `writeFileSync(tmp)` và `renameSync` để lại file
 * `.tmp` trong **20/20** lượt. Nên đây không phải một giả thuyết: nó xảy ra, và câu hỏi
 * duy nhất là hệ thống có đọc phải nó không. Ô này Bỏ LẠI một `.tmp` bằng tay — một
 * file JSON NỬA VỜI, để nếu có ai đọc nó thì vỡ ền ào thay vì sai âm thầm — rồi đòi
 * lượt sau vẫn hội tụ, VÀ `.tmp` bị dọn.
 */
describe("tầng 2 — .tmp bỏ lại sau kill -9", () => {
  it("file .tmp nửa vời không được đọc, và bị dọn ở lần mở sau", async () => {
    const started = Date.now();
    const { cloud, path, dispose } = freshCloud();
    try {
      await wipeRows(admin);
      await ensureJob();
      const first = await resumeUntilConverged({ ctx, cloud });
      expect(first.statuses.at(-1)?.every((x) => x === "SUCCESS")).toBe(true);

      /** Một `.tmp` nửa vời, đúng thứ `kill -9` giữa lúc ghi để lại */
      const tmpPath = `${path}.tmp`;
      writeFileSync(tmpPath, '{"seq":999,"resources":{"rac');
      expect(existsSync(tmpPath)).toBe(true);

      /** Mở lại cloud từ cùng đường dẫn: phải đọc file THẬT, không đọc `.tmp` */
      const reopened = new SimCloud({ statePath: path });
      const all = await reopened.listAll();
      expect(all.length).toBeGreaterThan(0);
      expect(existsSync(tmpPath), "`.tmp` phải bị dọn lúc mở").toBe(false);

      const second = await resumeUntilConverged({ ctx, cloud: reopened });
      expect(
        second.statuses.at(-1)?.every((x) => x === "SUCCESS"),
        JSON.stringify(second.statuses),
      ).toBe(true);
      await assertConverged({ ctx, cloud: reopened, label: ".tmp" });
      note(".tmp", Date.now() - started);
    } finally {
      dispose();
    }
  }, 120_000);
});

/**
 * Nhóm 9 — K8b / R-7: hai đường tra cứu CÙNG hỏng.
 *
 * Đây là rủi ro **đã chấp nhậ­n** trong bảng đánh giá của thiết kế, không phải một lỗi
 * chờ sửa: khách xoá tag `udp.key` **và** sổ mất `provider_id` cùng lúc thì cả hai đường
 * độc lậ­p đều mù, và adapter tạo thêm một tài nguyên.
 *
 * Vì sao nó vẫn cần một ô: một rủi ro đã chấp nhậ­n mà không có phép kiểm nào là một rủi
 * ro không ai biết hình dạng thật. Ô này chứng minh HAI điều, và điều thứ hai mới là
 * lý do nó chấp nhậ­n được: (1) đúng, có tài nguyên thứ hai; (2) cái bỏ lại **bị phát
 * hiện** — nó còn `udp.project`, nên phép đếm mồ côi thấy nó và
 * `GET /admin/orphan-resources` hiện nó kèm USD/giờ. Rò mà thấy được thì còn sửa được.
 */
describe("tầng 2 — K8b/R-7 hai đường tra cứu cùng hỏng", () => {
  it("tạo trùng như đã lượng, nhưng cái bỏ lại bị PHÁT HIỆN", async () => {
    const started = Date.now();
    const { cloud, dispose } = freshCloud();
    try {
      await wipeRows(admin);
      await ensureJob();
      const first = await resumeUntilConverged({ ctx, cloud });
      expect(first.statuses.at(-1)?.every((x) => x === "SUCCESS")).toBe(true);

      /** Một tài nguyên cụ thể: xoá tag `udp.key` trên cloud VÀ xoá id trong sổ */
      const target = (await cloud.listAll()).find(
        (r) => r.kind === "elastic-ip",
      );
      expect(target, "phải có một elastic-ip để làm mục tiêu").toBeDefined();
      const victim = target as NonNullable<typeof target>;
      await cloud.removeTag(victim.id, "udp.key");
      await admin.provisionedResource.updateMany({
        where: { projectId: CONTRACT_PROJECT, providerId: victim.id },
        data: { providerId: null, status: "CREATING" },
      });

      const second = await resumeUntilConverged({ ctx, cloud });
      expect(second.statuses.at(-1)?.every((x) => x === "SUCCESS")).toBe(true);

      /** (1) Có tài nguyên thứ hai cùng loại — đúng như rủi ro đã lượng */
      const eips = (await cloud.listAll()).filter(
        (r) => r.kind === "elastic-ip",
      );
      expect(eips.length).toBe(2);

      /** (2) Cái bỏ lại còn `udp.project`, nên phép đếm mồ côi thấy nó */
      const orphan = eips.find((r) => r.id === victim.id);
      expect(orphan?.tags["udp.project"]).toBe(CONTRACT_PROJECT);

      const ledgerIds = new Set(
        (
          await admin.provisionedResource.findMany({
            where: { projectId: CONTRACT_PROJECT },
            select: { providerId: true },
          })
        ).map((r) => r.providerId),
      );
      expect(ledgerIds.has(victim.id), "sổ KHÔNG còn biết id cũ").toBe(false);
      note("K8b", Date.now() - started);
    } finally {
      dispose();
    }
  }, 120_000);
});

/**
 * Meta-test — số ô và trần thời gian.
 *
 * Cả hai là con số, không phải cảm giác: bỏ một ô là một test đỏ, và vượt trần là một
 * test đỏ. N4 nói vượt trần thì tách project vitest, KHÔNG bỏ ô.
 */
describe("meta — lưới tầng 2", () => {
  it("mọi điểm crash có ít nhất một lượt trên PrismaLedger", () => {
    const covered = new Set(
      timings.map((t) => t.name.split("@")[0]).filter((s) => s !== undefined),
    );
    const missing = CRASH_POINTS.map((c) => c.id).filter((id) => {
      if (id === "K10") return !covered.has("K10a") || !covered.has("K10b");
      return !covered.has(id);
    });
    expect(missing).toEqual([]);
  });

  it("mọi ô child-only của §4.5 đã chạy ở tầng 2", () => {
    const childOnly = CRASH_POINTS.filter((c) => c.tier === "child-only").map(
      (c) => c.id,
    );
    const covered = new Set(timings.map((t) => t.name.split("@")[0]));
    const missing = childOnly.filter((id) =>
      id === "K10" ? !covered.has("K10a") : !covered.has(id),
    );
    expect(missing).toEqual([]);
  });

  it("tổng thời gian trong trần 8 phút của QĐ-23", () => {
    const total = timings.reduce((sum, t) => sum + t.ms, 0);
    const slowest = [...timings].sort((a, b) => b.ms - a.ms)[0];
    console.log(
      `[do] tầng 2: ${String(timings.length)} ô, tổng ${(total / 1000).toFixed(1)} s, ` +
        `ô chậm nhất ${slowest?.name ?? "?"} ${String(slowest?.ms ?? 0)} ms`,
    );
    expect(total).toBeLessThan(480_000);
  });
});
