import { MAX_TRACKED_FLAGS_PER_ENV } from "@udp/config";
import type { Prisma } from "@udp/db";
import { trackedStateOf } from "@udp/flag-snapshot";
import type { TrackResult } from "@udp/shared-types";
import { ConflictError, NotFoundError } from "@udp/http";
import { prisma } from "../../core/db.js";
import { writeConfigChange } from "../../core/outbox.js";
import * as repository from "./rollout.repository.js";

/**
 * Gắn/gỡ nhãn `ff` cho flag của một rollout FLAG_LEVEL (§6.6, §9 [v4.3]).
 *
 * Tập tracked nằm trên đường lan truyền chung: đổi nó là một lần ghi ADR-05
 * (khoá environment → đổi → hash → outbox), nên SDK nhận nó cùng cơ chế và cùng
 * bảo đảm với cấu hình flag, thay vì một kênh thứ hai phải tự kiểm.
 *
 * Mọi quyết định "có đổi không" được đưa ra DƯỚI khoá environment. Không có gì
 * để đổi thì transaction LÙI (`NoChange`) — `config_version` đã được cấp ở bước
 * 1 không được để lại, không thì mỗi lần gọi lặp là một lần SDK tải lại vô cớ.
 *
 * `track` KHÔNG có đường tắt đọc trước khoá, có chủ đích: một `untrack` đang giữ
 * khoá có thể đã quyết gỡ (chưa thấy session mới) — `track` đọc `is_tracked = true`
 * ngoài khoá sẽ trả "đã track" rồi `untrack` commit `false`, và rollout mới chạy
 * mà không có nhãn nào gắn lại được. Chỉ `untrack` giữ đường tắt: bỏ qua khi
 * không track là quyết định an toàn theo mọi thứ tự.
 */

const NOT_FOUND = "Không tìm thấy rollout FLAG_LEVEL này";
const CONFIG_NOT_FOUND = "Không tìm thấy cấu hình flag theo environment";

class NoChange extends Error {
  constructor(readonly result: TrackResult) {
    super("no change");
  }
}

async function configOfSession(sessionId: string): Promise<string> {
  const session = await repository.sessionConfigOf(prisma, sessionId);
  if (session === null || session.configId === null) {
    throw new NotFoundError(NOT_FOUND);
  }
  return session.configId;
}

async function targetOf(configId: string): Promise<repository.TrackTarget> {
  const target = await repository.trackTargetOf(prisma, configId);
  if (target === null) {
    throw new NotFoundError(CONFIG_NOT_FOUND);
  }
  return target;
}

const NOT_FOUND_RESULT: TrackResult = {
  tracked: false,
  changed: false,
  skipped: "not-found",
};

const unchanged = (
  target: repository.TrackTarget,
  skipped: "already-tracked" | "not-tracked" | "active-session",
): TrackResult => ({
  flagKey: target.flagKey,
  environmentId: target.environmentId,
  tracked: target.isTracked,
  changed: false,
  skipped,
});

async function write(
  target: repository.TrackTarget,
  tracked: boolean,
  decide: (
    tx: Prisma.TransactionClient,
    fresh: repository.TrackTarget,
  ) => Promise<void>,
  /** Env-config đã bị xoá trong khe giữa lần đọc ngoài và lần đọc dưới khoá */
  onMissing: () => never | TrackResult,
): Promise<TrackResult> {
  try {
    await writeConfigChange({
      environmentIds: [target.environmentId],
      changeType: tracked ? "rollout.tracked" : "rollout.untracked",
      mutate: async (tx) => {
        const fresh = await repository.trackTargetOf(tx, target.configId);
        if (fresh === null) throw new NoChange(onMissing());
        await decide(tx, fresh);
        await repository.setTracked(tx, target.configId, tracked);
      },
      stateOf: trackedStateOf,
    });
  } catch (err) {
    if (err instanceof NoChange) return err.result;
    throw err;
  }
  return {
    flagKey: target.flagKey,
    environmentId: target.environmentId,
    tracked,
    changed: true,
  };
}

/**
 * `POST /internal/rollouts/:sessionId/track` — Service 1 gọi khi tạo rollout.
 * 409 `TRACKED_FLAG_LIMIT` khi environment đã đủ `MAX_TRACKED_FLAGS_PER_ENV`
 * (trần cardinality §6.6); rollout đã kết thúc không được gắn nhãn.
 */
export async function track(sessionId: string): Promise<TrackResult> {
  const configId = await configOfSession(sessionId);
  const target = await targetOf(configId);

  return write(
    target,
    true,
    async (tx, fresh) => {
      // [v4.5] Dưới khoá env: một lần archive (cũng khoá env) không chen giữa được.
      // S1 kiểm lifecycle NGOÀI khoá lúc tạo rollout; chốt thật nằm ở đây. Hai chốt
      // (flag ACTIVE, session còn chạy) đứng TRƯỚC lối tắt "đã gắn nhãn":
      // `is_tracked` còn true sau khi rollout trước kết thúc (S3 chưa untrack) là
      // trạng thái bình thường, và lối tắt đó từng trả SUCCESS cho rollout mới trên
      // một flag vừa bị lưu trữ.
      if (!fresh.flagActive) {
        throw new ConflictError(
          "Flag không còn ACTIVE — không gắn nhãn cho một flag đã lưu trữ hay chưa kích hoạt",
        );
      }
      const session = await repository.sessionConfigOf(tx, sessionId);
      if (session === null) throw new NotFoundError(NOT_FOUND);
      if (!session.active) {
        throw new ConflictError(
          "Rollout đã kết thúc — không gắn nhãn cho một rollout không còn chạy",
        );
      }
      if (fresh.isTracked)
        throw new NoChange(unchanged(fresh, "already-tracked"));
      const count = await repository.trackedCountOf(tx, fresh.environmentId);
      if (count >= MAX_TRACKED_FLAGS_PER_ENV) {
        throw new ConflictError(
          `Environment đã có ${String(count)} flag đang gắn nhãn (tối đa ${String(MAX_TRACKED_FLAGS_PER_ENV)})`,
          { environmentId: fresh.environmentId },
          "TRACKED_FLAG_LIMIT",
        );
      }
    },
    () => {
      throw new NotFoundError(CONFIG_NOT_FOUND);
    },
  );
}

/**
 * `POST /internal/flag-envs/:id/untrack` — gỡ nhãn của một env-config, bỏ qua khi
 * config còn session đang chạy; gọi lặp vô hại.
 *
 * Theo CONFIG chứ không theo session, vì lưới gỡ nhãn của Service 3 phải sống
 * sót cả khi hàng session đã bị xoá (S1 có quyền xoá; xoá rule cuốn session đã
 * kết thúc) — không thì flag giữ một chỗ trong trần 3 mãi mãi.
 */
export async function untrackConfig(configId: string): Promise<TrackResult> {
  const target = await repository.trackTargetOf(prisma, configId);
  if (target === null) return NOT_FOUND_RESULT;
  if (!target.isTracked) return unchanged(target, "not-tracked");

  return write(
    target,
    false,
    async (tx, fresh) => {
      if (!fresh.isTracked) throw new NoChange(unchanged(fresh, "not-tracked"));
      if (await repository.hasActiveSession(tx, fresh.configId)) {
        throw new NoChange(unchanged(fresh, "active-session"));
      }
    },
    () => NOT_FOUND_RESULT,
  );
}
