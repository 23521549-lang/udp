import { loadTimezoneNames, type ProjectRole } from "@udp/db";
import {
  ConfirmationRequiredError,
  ForbiddenError,
  logger,
  NotFoundError,
  OptimisticLockError,
  RelayedProblemError,
  ServiceUnavailableError,
  ValidationError,
  type AuditContext,
} from "@udp/http";
import { planPromotion } from "@udp/shared-types/promote";
import type { AppDeps } from "../../core/app-deps.js";
import { prisma } from "../../core/db.js";
import { hasMinProjectRole } from "../../core/http/middlewares/project-role.middleware.js";
import * as repository from "./flag.repository.js";
import type { TesterResult } from "@udp/shared-types";
import type {
  BulkArchiveBody,
  BulkArchiveOutcome,
  CreateFlagBody,
  EvaluateBody,
  FlagDetail,
  FlagEnvState,
  FlagStatsQueryBody,
  FlagStatsView,
  FlagSummary,
  ListFlagsQuery,
  PromoteBody,
  PromoteView,
  ReplaceRulesBody,
  ReplaceVariantsBody,
  RulesView,
  StaleFlagsQueryBody,
  UpdateEnvBody,
  UpdateFlagBody,
} from "./flag.types.js";
import type { StaleFlagsResponse } from "@udp/shared-types";

/**
 * Luồng 4 ở Service 1 (§8.4) [v4.5]: S1 xác thực, kiểm SỞ HỮU (S2 không biết
 * env-config thuộc project nào), kiểm QUYỀN theo environment (§2.2), đòi XÁC NHẬN
 * hai bước — rồi nhờ Service 2 ghi. S2 ghi thay đổi, outbox VÀ audit trong một
 * transaction; S1 không ghi audit hộ (đó là dual-write, §1.2).
 *
 * Quyền (§2.2): tạo flag, sửa mô tả, và bật/sửa rule ở env non-production =
 * DEVELOPER; env production và đổi vòng đời/stickiness = MAINTAINER. Mức cần chỉ
 * biết SAU khi đọc env, nên route gắn `DEVELOPER` và service nâng lên khi cần —
 * cùng bảng thứ bậc (`hasMinProjectRole`).
 *
 * Xác nhận KHÔNG dựa vào trạng thái S1 đọc được (QA code Plan #19): S1 đọc ngoài
 * khoá của S2, nên "flag đang tắt ⇒ bật cần xác nhận" để lọt một form cũ bật lại
 * flag vừa bị kill-switch. Luật chỉ nhìn vào REQUEST: mọi thao tác có thể làm
 * người dùng production nhận giá trị khác thì hỏi, trừ TẮT.
 *
 * Ghi xong, S1 đọc lại view của CHÍNH nó: POST/PATCH trả cùng hình với GET, và
 * không hình nội bộ nào của S2 (`bucketSalt`) đi lên Portal.
 */

const FLAG_NOT_FOUND = "Không tìm thấy flag trong project này";
const ENV_NOT_FOUND = "Không tìm thấy flag này ở environment này của project";

function requireRole(
  role: ProjectRole | undefined,
  minimum: ProjectRole,
  why: string,
): void {
  if (!hasMinProjectRole(role, minimum)) {
    throw new ForbiddenError(`Cần quyền ${minimum}: ${why}`);
  }
}

/**
 * Xác nhận hai bước (§8.4): người dùng gõ lại key của flag. Thiếu hay sai ⇒ 428
 * `CONFIRMATION_REQUIRED` — Portal mở hộp xác nhận rồi gửi lại.
 */
function requireConfirmation(
  confirmFlagKey: string | undefined,
  flagKey: string,
  what: string,
): void {
  if (confirmFlagKey !== flagKey) {
    throw new ConfirmationRequiredError(
      `${what} — gõ lại key "${flagKey}" để xác nhận`,
    );
  }
}

async function detailOf(
  projectId: string,
  flagId: string,
): Promise<FlagDetail> {
  const flag = await repository.detail(projectId, flagId);
  if (flag === undefined) throw new NotFoundError(FLAG_NOT_FOUND);
  return flag;
}

// ------------------------------------------------------------- ghi

export async function create(
  deps: AppDeps,
  projectId: string,
  body: CreateFlagBody,
  ctx: AuditContext,
): Promise<FlagDetail> {
  const flagId = await deps.flagService.createFlag({ ...body, projectId }, ctx);
  return detailOf(projectId, flagId);
}

/**
 * Sửa định nghĩa flag. `description` là DEVELOPER; đổi `lifecycleStatus` hay
 * `stickinessAttribute` là MAINTAINER VÀ xác nhận hai bước, vì cả hai tác động
 * TOÀN CỤC: ARCHIVED là bia mộ ở MỌI env (lưu trữ = tắt ở production), đổi
 * stickiness băm lại mọi người dùng. Hỏi xác nhận bất kể flag đang bật ở đâu —
 * trạng thái đó S1 chỉ đọc được ngoài khoá.
 */
export async function update(
  deps: AppDeps,
  projectId: string,
  flagId: string,
  body: UpdateFlagBody,
  role: ProjectRole | undefined,
  ctx: AuditContext,
): Promise<FlagDetail> {
  const flag = await repository.flagOf(projectId, flagId);
  if (flag === undefined) throw new NotFoundError(FLAG_NOT_FOUND);

  const { confirmFlagKey, ...change } = body;
  const global =
    (change.lifecycleStatus !== undefined &&
      change.lifecycleStatus !== flag.lifecycleStatus) ||
    (change.stickinessAttribute !== undefined &&
      change.stickinessAttribute !== flag.stickinessAttribute);
  if (global) {
    requireRole(
      role,
      "MAINTAINER",
      "đổi vòng đời hay stickiness tác động mọi environment",
    );
    requireConfirmation(
      confirmFlagKey,
      flag.key,
      "Đổi vòng đời hay stickiness tác động mọi environment, kể cả production",
    );
  }
  await deps.flagService.updateFlag(flagId, change, ctx);
  return detailOf(projectId, flagId);
}

/**
 * Bật/tắt, đổi variant mặc định ở MỘT environment. Production: MAINTAINER, và
 * mọi thay đổi trừ TẮT cần xác nhận hai bước — bật hay đổi variant mặc định đều
 * đổi giá trị người dùng production nhận. TẮT thì không hỏi: đó là kill-switch
 * của người vận hành, phải luôn nhanh.
 */
export async function updateEnv(
  deps: AppDeps,
  projectId: string,
  flagId: string,
  envId: string,
  body: UpdateEnvBody,
  role: ProjectRole | undefined,
  ctx: AuditContext,
): Promise<FlagEnvState> {
  const target = await repository.envTargetOf(projectId, flagId, envId);
  if (target === undefined) throw new NotFoundError(ENV_NOT_FOUND);

  const { confirmFlagKey, ...change } = body;
  if (target.isProduction) {
    requireRole(role, "MAINTAINER", "environment production (§2.2)");
    const killSwitch =
      change.isEnabled === false && change.defaultVariantId === undefined;
    if (!killSwitch) {
      requireConfirmation(
        confirmFlagKey,
        target.flagKey,
        "Bật flag hay đổi variant mặc định ở production",
      );
    }
  }
  await deps.flagService.updateEnvConfig(target.configId, change, ctx);
  const state = await repository.envStateOf(target.configId);
  if (state === undefined) throw new NotFoundError(ENV_NOT_FOUND);
  return state;
}

/**
 * Thay toàn bộ rule của một env-config. Production: MAINTAINER; không hỏi xác
 * nhận — PUT đã mang optimistic lock, và Portal hiện diff trước khi lưu (§10.8).
 */
export async function replaceRules(
  deps: AppDeps,
  projectId: string,
  flagId: string,
  envId: string,
  body: ReplaceRulesBody,
  role: ProjectRole | undefined,
  ctx: AuditContext,
): Promise<RulesView> {
  const target = await repository.envTargetOf(projectId, flagId, envId);
  if (target === undefined) throw new NotFoundError(ENV_NOT_FOUND);
  if (target.isProduction) {
    requireRole(role, "MAINTAINER", "sửa rule ở environment production (§2.2)");
  }
  await deps.flagService.replaceRules(target.configId, body, ctx);
  return rulesOrNotFound(target.configId);
}

/**
 * [v4.11, Plan #44] Thay toàn bộ variant của flag. Variant dùng ở MỌI environment: flag DRAFT (SDK
 * chưa thấy) là DEVELOPER; flag đã phục vụ (ACTIVE, ARCHIVED) là MAINTAINER và gõ lại key — đổi giá
 * trị một variant là đổi thứ người dùng production nhận, cùng luật thay đổi toàn cục của `update()`.
 */
export async function replaceVariants(
  deps: AppDeps,
  projectId: string,
  flagId: string,
  body: ReplaceVariantsBody,
  role: ProjectRole | undefined,
  ctx: AuditContext,
): Promise<FlagDetail> {
  const flag = await repository.flagOf(projectId, flagId);
  if (flag === undefined) throw new NotFoundError(FLAG_NOT_FOUND);

  const { confirmFlagKey, ...change } = body;
  if (flag.lifecycleStatus !== "DRAFT") {
    requireRole(
      role,
      "MAINTAINER",
      "sửa variant của flag đang phục vụ tác động mọi environment",
    );
    requireConfirmation(
      confirmFlagKey,
      flag.key,
      "Sửa variant của flag đang phục vụ tác động mọi environment, kể cả production",
    );
  }
  await deps.flagService.replaceVariants(flagId, change, ctx);
  return detailOf(projectId, flagId);
}

/**
 * [v4.11, Plan #44] Sao chép rule env nguồn → env đích (§10.12) bằng CÙNG `planPromotion` mà Portal
 * dùng để hiện diff, trên dữ liệu đọc ngay trong lời gọi. Hai mốc làm "diff đã xem" và "thứ được
 * ghi" không lệch được: nguồn so ở đây (`sourceUpdatedAt`), đích so ở Service 2 trong khoá env
 * (`lastKnownUpdatedAt` của thân `PUT …/rules`). Quyền của đích như `replaceRules`, cộng gõ lại key
 * khi đích là production: một lần chép là thay cả bộ rule, Portal đã hỏi ở trình duyệt — nay máy chủ
 * giữ luật đó.
 */
export async function promote(
  deps: AppDeps,
  projectId: string,
  flagId: string,
  body: PromoteBody,
  role: ProjectRole | undefined,
  ctx: AuditContext,
): Promise<PromoteView> {
  const [source, target] = await Promise.all([
    repository.envTargetOf(projectId, flagId, body.fromEnvId),
    repository.envTargetOf(projectId, flagId, body.toEnvId),
  ]);
  if (source === undefined || target === undefined) {
    throw new NotFoundError(ENV_NOT_FOUND);
  }
  if (target.isProduction) {
    requireRole(role, "MAINTAINER", "sửa rule ở environment production (§2.2)");
    requireConfirmation(
      body.confirmFlagKey,
      target.flagKey,
      "Sao chép rule sang production",
    );
  }

  const [from, to] = await Promise.all([
    rulesOrNotFound(source.configId),
    rulesOrNotFound(target.configId),
  ]);
  if (
    new Date(from.updatedAt).getTime() !==
    new Date(body.sourceUpdatedAt).getTime()
  ) {
    throw new OptimisticLockError(
      "Rule ở environment nguồn đã đổi từ lúc bạn xem diff",
      from,
    );
  }

  const plan = planPromotion(from.rules, to.rules, body.lastKnownUpdatedAt);
  if (plan.changes === 0) return { ...to, diff: plan.diff, changes: 0 };
  await deps.flagService.replaceRules(target.configId, plan.body, ctx);
  return {
    ...(await rulesOrNotFound(target.configId)),
    diff: plan.diff,
    changes: plan.changes,
  };
}

// ------------------------------------------------------------- đọc

/**
 * [v4.6] Flag Evaluation Tester — thử đánh giá với context giả, bằng CÙNG hàm
 * với SDK và OFREP (I26). Chỉ đọc: VIEWER. Sở hữu kiểm ở đây như mọi route khác
 * (S2 không biết project nào đang hỏi).
 */
export async function evaluateFlag(
  deps: AppDeps,
  projectId: string,
  flagId: string,
  body: EvaluateBody,
): Promise<TesterResult> {
  const target = await repository.envTargetOf(projectId, flagId, body.envId);
  if (target === undefined) throw new NotFoundError(ENV_NOT_FOUND);
  return deps.flagService.evaluateFlag(flagId, {
    environmentId: body.envId,
    context: body.context,
  });
}

export async function list(
  deps: AppDeps,
  projectId: string,
  query: ListFlagsQuery,
): Promise<{ flags: FlagSummary[]; total: number }> {
  const envId = query.envId;
  /**
   * [v4.11, Plan #41] Phép kiểm sở hữu env chạy SONG SONG với truy vấn trang — một lượt đi về
   * database ít hơn (đo: mỗi lượt ~100 ms ở hình học dev). An toàn: env của project khác không
   * khớp `FlagEnvConfig` nào của project này, và kết quả bị bỏ trước khi trả nếu env lạ.
   */
  const [belongs, { flags, total }] = await Promise.all([
    envId === undefined
      ? Promise.resolve(true)
      : repository.environmentBelongsTo(projectId, envId),
    repository.list(projectId, query),
  ]);
  if (!belongs) {
    throw new NotFoundError("Không tìm thấy environment trong project này");
  }
  if (query.include !== "stats" || envId === undefined || flags.length === 0) {
    return { flags, total };
  }

  /**
   * [v4.9] Sparkline của cả trang trong MỘT lời gọi S2 (V19): S1 không đọc bảng
   * stats dù có quyền SELECT — một module duy nhất biết SQL của nó, kể cả SQL của
   * hàng đã rollup theo ngày.
   */
  await assertKnownTimezone(query.tz);
  const summary = await deps.flagService.flagStatsSummary({
    environmentId: envId,
    flagIds: flags.map((flag) => flag.id),
    tz: query.tz,
  });
  const statsOf = new Map(
    summary.items.map((item) => [
      item.flagId,
      { evalCount7d: item.evalCount7d, daily14: item.daily14 },
    ]),
  );
  return {
    flags: flags.map((flag) => {
      const stats = statsOf.get(flag.id);
      return stats === undefined ? flag : { ...flag, stats };
    }),
    total,
  };
}

/**
 * [v4.9] Stats của MỘT flag (§3.1).
 *
 * `tz` kiểm ĐẦY ĐỦ ở đây — hình dạng bằng `tzSchema` (schema của route) và tên
 * bằng `pg_timezone_names` — vì 400 từ S2 tới S1 là lệch hợp đồng, tức 500 cho
 * người dùng. Kiểm hai lần (S2 kiểm lại) là có chủ đích: S1 để trả 400 đúng, S2
 * để không tin tham số nó nhận (V17).
 */
export async function flagStats(
  deps: AppDeps,
  projectId: string,
  flagId: string,
  query: FlagStatsQueryBody,
): Promise<FlagStatsView> {
  const flag = await repository.flagOf(projectId, flagId);
  if (flag === undefined) throw new NotFoundError(FLAG_NOT_FOUND);
  const envId = query.envId;
  if (
    envId !== undefined &&
    !(await repository.environmentBelongsTo(projectId, envId))
  ) {
    throw new NotFoundError("Không tìm thấy environment trong project này");
  }
  await assertKnownTimezone(query.tz);

  const stats = await deps.flagService.flagStats(flagId, {
    days: query.days,
    granularity: query.granularity,
    tz: query.tz,
    ...(envId === undefined ? {} : { environmentId: envId }),
  });
  const names = new Map(
    (await repository.environmentsOf(projectId)).map((env) => [env.id, env]),
  );
  return {
    ...stats,
    byEnv: stats.byEnv.map(({ environmentId, ...rest }) => {
      const environment = names.get(environmentId);
      if (environment === undefined) {
        logger.error(
          { flagId, environmentId },
          "Service 2 trả stats của environment không thuộc project — hai service lệch hợp đồng",
        );
        throw new Error("Stats của Service 2 mang environment lạ");
      }
      return { ...rest, environment };
    }),
  };
}

/** [v4.9] Cleanup Center (§3.1) — S1 chỉ kiểm quyền rồi chuyển tiếp */
export const staleFlags = (
  deps: AppDeps,
  projectId: string,
  query: StaleFlagsQueryBody,
): Promise<StaleFlagsResponse> =>
  deps.flagService.staleFlags({ ...query, projectId });

/**
 * [v4.9] Archive hàng loạt (V16) — thứ tự kiểm là phần quan trọng nhất của hàm
 * này: 400 (schema, id trùng — ở route) → 428 `confirmProjectName` → 404 nếu có
 * flag ngoài project → rồi mới GHI, tuần tự, mỗi flag một transaction ở S2.
 *
 * Vì sao không một transaction cho cả lô: 20 flag × fan-out mọi environment là 20
 * lần khoá MỌI environment của project; gộp lại thì khoá bị giữ suốt ~44 giây và
 * kill-switch của người vận hành phải chờ (R31, R15c). Giá phải trả là lô không
 * nguyên tử, nên phản hồi nói rõ từng flag, và hai ca DỪNG bên dưới nói rõ đã áp
 * dụng được mấy flag.
 *
 * Vì sao gõ lại TÊN PROJECT chứ không một `confirm: true` hay một `confirmCount`:
 * cả hai gửi mù được, còn tên project buộc người bấm đọc xem mình đang tác động
 * vào project nào — cùng lý lẽ `confirmFlagKey` của §8.4 (design:4772).
 */
export async function bulkArchive(
  deps: AppDeps,
  projectId: string,
  body: BulkArchiveBody,
  ctx: AuditContext,
): Promise<BulkArchiveOutcome[]> {
  const projectName = await repository.projectNameOf(projectId);
  if (projectName === undefined) {
    throw new NotFoundError("Không tìm thấy project");
  }
  const confirm = body.confirmProjectName;
  if (confirm === undefined || !sameName(confirm, projectName)) {
    throw new ConfirmationRequiredError(
      `Lưu trữ ${String(body.flags.length)} flag tác động mọi environment, kể cả production — gõ lại tên project "${projectName}" để xác nhận`,
    );
  }

  /**
   * Sở hữu kiểm cho CẢ lô TRƯỚC lần ghi đầu tiên: 404 giữa lô sẽ để lại một số
   * flag đã lưu trữ cho một request mà người dùng đọc là "thất bại".
   */
  const owned = await repository.flagIdsInProject(
    projectId,
    body.flags.map((flag) => flag.flagId),
  );
  if (owned.size !== body.flags.length) {
    throw new NotFoundError(FLAG_NOT_FOUND);
  }

  const results: BulkArchiveOutcome[] = [];
  for (const target of body.flags) {
    try {
      await deps.flagService.updateFlag(
        target.flagId,
        {
          lastKnownUpdatedAt: target.lastKnownUpdatedAt,
          lifecycleStatus: "ARCHIVED",
        },
        ctx,
      );
      results.push({
        flagId: target.flagId,
        ok: true,
        flag: await detailOf(projectId, target.flagId),
      });
    } catch (err: unknown) {
      /**
       * 404/409/422 là câu trả lời có nghĩa cho MỘT flag (flag vừa bị xoá, mốc
       * cũ, còn lượt đánh giá, còn rollout): ghi lại rồi đi tiếp.
       */
      if (err instanceof RelayedProblemError) {
        results.push({
          flagId: target.flagId,
          ok: false,
          problem: {
            status: err.statusCode,
            title: err.problem.title,
            ...(err.problem.detail === undefined
              ? {}
              : { detail: err.problem.detail }),
            ...(err.problem.code === undefined
              ? {}
              : { code: err.problem.code }),
            ...(err.resourceId === undefined
              ? {}
              : { resourceId: err.resourceId }),
          },
        });
        continue;
      }
      throw stopBatch(err, results.length, body.flags.length);
    }
  }
  return results;
}

/**
 * Lô dừng giữa đường: 5xx/mạng ⇒ 503 (thử lại có ích), còn lại ⇒ 500 (hai service
 * lệch hợp đồng hay cấu hình). Cả hai mang số flag ĐÃ áp dụng: người dùng vừa gửi
 * một thao tác không hoàn tác được và cần biết nó đã đi được bao xa.
 */
function stopBatch(err: unknown, applied: number, total: number): Error {
  const how = `${String(applied)}/${String(total)} flag đã được lưu trữ trước khi lô dừng — tải lại danh sách`;
  if (err instanceof ServiceUnavailableError) {
    return new ServiceUnavailableError(
      `Service 2 không phục vụ được giữa lô: ${how}`,
    );
  }
  logger.error(
    { err, applied, total },
    "Service 2 từ chối một lời gọi của lô archive — hai service lệch hợp đồng hoặc cấu hình",
  );
  return new Error(`Lô archive dừng vì lỗi hợp đồng với Service 2: ${how}`);
}

/**
 * So xác nhận sau `trim()` và `normalize("NFC")` ở CẢ HAI phía (F9, X-1).
 *
 * Người dùng dán tên project từ chỗ khác thường mang theo khoảng trắng ở hai đầu;
 * và "Việt" gõ trên macOS (NFD: V-i-ê-t rời dấu) với "Việt" lưu trong database
 * (NFC) là hai chuỗi UTF-8 KHÁC nhau mà mắt người đọc là một. Chuẩn hoá cả hai về
 * NFC là cách duy nhất để phép so nói đúng thứ người dùng thấy.
 */
const sameName = (a: string, b: string): boolean =>
  a.trim().normalize("NFC") === b.trim().normalize("NFC");

/**
 * `tz` phải là tên Postgres BIẾT (V17): tzdata của ICU trong Node và của Postgres
 * có thể khác phiên bản, nên hình dạng đúng chưa đủ. Tập đọc MỘT lần mỗi tiến
 * trình; lần đọc lỗi không được nhớ, nên một sự cố database không khoá chức năng
 * tới lúc khởi động lại.
 */
async function assertKnownTimezone(tz: string): Promise<void> {
  const names = await loadTimezoneNames(prisma);
  if (!names.has(tz)) {
    throw new ValidationError(`Không có múi giờ "${tz}"`);
  }
}

export const get = detailOf;

export async function rules(
  projectId: string,
  flagId: string,
  envId: string,
): Promise<RulesView> {
  const target = await repository.envTargetOf(projectId, flagId, envId);
  if (target === undefined) throw new NotFoundError(ENV_NOT_FOUND);
  return rulesOrNotFound(target.configId);
}

async function rulesOrNotFound(configId: string): Promise<RulesView> {
  const view = await repository.rulesOf(configId);
  if (view === undefined) throw new NotFoundError(ENV_NOT_FOUND);
  return view;
}
