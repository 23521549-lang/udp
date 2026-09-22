import type { ProjectRole } from "@udp/db";
import {
  ConfirmationRequiredError,
  ForbiddenError,
  NotFoundError,
  type AuditContext,
} from "@udp/http";
import type { AppDeps } from "../../core/app-deps.js";
import { hasMinProjectRole } from "../../core/http/middlewares/project-role.middleware.js";
import * as repository from "./flag.repository.js";
import type { TesterResult } from "@udp/shared-types";
import type {
  CreateFlagBody,
  EvaluateBody,
  FlagDetail,
  FlagEnvState,
  FlagSummary,
  ListFlagsQuery,
  ReplaceRulesBody,
  RulesView,
  UpdateEnvBody,
  UpdateFlagBody,
} from "./flag.types.js";

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
  projectId: string,
  query: ListFlagsQuery,
): Promise<FlagSummary[]> {
  if (
    query.envId !== undefined &&
    !(await repository.environmentBelongsTo(projectId, query.envId))
  ) {
    throw new NotFoundError("Không tìm thấy environment trong project này");
  }
  return repository.list(projectId, query);
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
