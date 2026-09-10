import { randomUUID } from "node:crypto";
import { writeWithOutbox, type Prisma } from "@udp/db";
import { ConflictError, NotFoundError, OptimisticLockError } from "@udp/http";
import { prisma } from "../../core/db.js";
import { stateFor } from "../../evaluation/snapshot-builder.js";
import * as repository from "./rule.repository.js";
import type { ReplaceRulesInput, PublicRule } from "./rule.types.js";
import {
  assertSegmentsInProject,
  canonicalRules,
  planRules,
} from "./rule.validator.js";

const NOT_FOUND = "Không tìm thấy cấu hình flag theo environment";

/**
 * Thay danh sách rule của một env-config (§8.4) — upsert theo danh tính.
 *
 * Mọi thứ nằm TRONG `mutate`, sau khi bước 1 của ADR-05 đã khoá environment:
 * đọc mốc optimistic lock, đọc danh sách cũ, kiểm rollout đang giữ rule. Đặt
 * bất kỳ phép đọc nào trong số đó ra ngoài là để lọt đúng khe hở mà khoá sinh
 * ra để đóng — đã đo được hình dạng lost update đó trên database thật khi kiểm
 * trước rồi mới ghi.
 */
export async function replaceRules(
  flagEnvConfigId: string,
  input: ReplaceRulesInput,
  actorUserId: string | undefined,
): Promise<{ rules: PublicRule[]; updatedAt: Date }> {
  const target = await repository.envConfigTargetOf(prisma, flagEnvConfigId);
  if (target === null) throw new NotFoundError(NOT_FOUND);

  const incoming = canonicalRules(input.rules);
  let result: { rules: PublicRule[]; updatedAt: Date } | undefined;

  await writeWithOutbox(prisma, {
    environmentIds: [target.environmentId],
    changeType: "rule.replaced",
    ...(actorUserId === undefined ? {} : { actorUserId }),
    mutate: async (tx) => {
      const fresh = await repository.envConfigTargetOf(tx, flagEnvConfigId);
      if (fresh === null) throw new NotFoundError(NOT_FOUND);

      /**
       * §8.4: "409 Conflict + bản mới nhất để hiển thị diff". Người dùng cần
       * thấy người kia đã lưu GÌ để quyết định, không chỉ biết mình đã thua.
       */
      if (
        fresh.updatedAt.getTime() !==
        new Date(input.lastKnownUpdatedAt).getTime()
      ) {
        throw new OptimisticLockError(
          "Rule của environment này vừa được người khác sửa",
          {
            updatedAt: fresh.updatedAt,
            rules: await repository.rulesOf(tx, flagEnvConfigId),
          },
        );
      }

      await assertSegmentsInProject(tx, fresh.projectId, incoming);

      const plan = planRules(
        await repository.rulesOf(tx, flagEnvConfigId),
        incoming,
      );
      await assertNoRolloutConflict(tx, plan);

      await applyPlan(tx, flagEnvConfigId, plan);

      /**
       * Đẩy mốc optimistic lock bằng tay, TƯỜNG MINH.
       *
       * Lần ghi này chạm `flag_targeting_rules`, không chạm `flag_env_configs`,
       * nên `@updatedAt` của hàng cha đứng yên — và đã đo: kể cả
       * `update({ data: {} })` cũng không làm nó nhảy, vì Prisma bỏ qua câu lệnh
       * rỗng. Không có dòng này thì hai PUT đồng thời cùng qua phép so ở trên,
       * và người lưu sau ghi đè người lưu trước mà không ai biết.
       */
      const bumped = await tx.flagEnvConfig.update({
        where: { id: flagEnvConfigId },
        data: { updatedAt: new Date() },
        select: { updatedAt: true },
      });

      result = {
        rules: await repository.rulesOf(tx, flagEnvConfigId),
        updatedAt: bumped.updatedAt,
      };
    },
    stateOf: stateFor(target.flagKey),
  });

  if (result === undefined) {
    throw new Error("writeWithOutbox trả về mà không chạy mutate");
  }
  return result;
}

/**
 * Rule đang bị một rollout hoạt động giữ thì bất biến, trừ mô tả.
 *
 * §1.2: "chỉ tồn tại MỘT writer duy nhất tới đối tượng điều khiển traffic". Và
 * schema nói thẳng chốt "không xoá khi đang rollout" nằm ở tầng ứng dụng, mã
 * `ROLLOUT_IN_PROGRESS` — vì khoá ngoại là CASCADE: xoá rule sẽ ÂM THẦM xoá luôn
 * `RolloutSession` đang chạy. Đã đo đúng hình dạng đó trên database thật.
 */
async function assertNoRolloutConflict(
  tx: Prisma.TransactionClient,
  plan: Awaited<ReturnType<typeof planRules>>,
): Promise<void> {
  const touched = [
    ...plan.remove,
    ...plan.update.filter((u) => u.trafficChanged).map((u) => u.id),
  ];
  const held = await repository.activeRolloutRuleIds(tx, touched);
  if (held.size === 0) return;

  throw new ConflictError(
    "Rule đang có rollout hoạt động — chỉ được sửa mô tả cho tới khi rollout kết thúc",
    { ruleIds: [...held] },
    "ROLLOUT_IN_PROGRESS",
  );
}

/**
 * Áp kế hoạch: xoá, sửa tại chỗ, rồi tạo mới.
 *
 * Sửa KHÔNG chạm `bucketSalt` — đó là toàn bộ lý do có kế hoạch này thay vì xoá
 * hết chèn lại. Đã đo: đổi salt rồi nâng 20% → 30% làm 69,4% người đang thấy
 * `on` mất quyền thấy; giữ salt thì con số đó là 0.
 *
 * Tạo mới dùng `createMany` — một câu lệnh bất kể bao nhiêu rule, vì mọi lượt đi
 * về ở đây đều diễn ra trong lúc đang giữ khoá environment.
 */
async function applyPlan(
  tx: Prisma.TransactionClient,
  flagEnvConfigId: string,
  plan: Awaited<ReturnType<typeof planRules>>,
): Promise<void> {
  if (plan.remove.length > 0) {
    await tx.flagTargetingRule.deleteMany({
      where: { id: { in: plan.remove }, flagEnvConfigId },
    });
  }

  for (const { id, next } of plan.update) {
    await tx.flagTargetingRule.update({
      where: { id },
      data: {
        ruleType: next.ruleType,
        condition: next.condition as Prisma.InputJsonValue,
        serve: next.serve,
        priority: next.priority,
        description: next.description ?? null,
      },
    });
  }

  if (plan.create.length > 0) {
    await tx.flagTargetingRule.createMany({
      data: plan.create.map((r) => ({
        flagEnvConfigId,
        ruleType: r.ruleType,
        condition: r.condition as Prisma.InputJsonValue,
        serve: r.serve,
        priority: r.priority,
        description: r.description ?? null,
        // Sinh MỘT LẦN, ở server, lúc tạo — và không bao giờ đổi (§8.4, I1)
        bucketSalt: randomUUID(),
      })),
    });
  }
}
