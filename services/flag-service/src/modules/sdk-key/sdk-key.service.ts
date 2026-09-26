import { SDK_KEY } from "@udp/config";
import { dbConstraintError } from "@udp/db";
import { recomputedStateOf } from "@udp/flag-snapshot";
import {
  ConflictError,
  NotFoundError,
  UnprocessableError,
  type AuditContext,
} from "@udp/http";
import { recordAudit } from "../../core/audit.js";
import { prisma } from "../../core/db.js";
import { writeConfigChange } from "../../core/outbox.js";
import * as repository from "./sdk-key.repository.js";
import type {
  CreateSdkKeyInput,
  SdkKeyRevocation,
  SdkKeyStamp,
} from "./sdk-key.types.js";

/**
 * Phát hành và thu hồi SDK key (§3.2, L1, L7, V4, V5) [v4.9].
 *
 * Service này KHÔNG bao giờ thấy plaintext. Nó nhận `keyHash` và `keySuffix` do
 * Service 1 tính rồi lưu đúng chúng — nên không có gì để rò qua log, qua
 * `details` của một lỗi, hay qua một bản dump database của chính bảng này (R04).
 * Đó cũng là thứ làm lần THỬ LẠI của Service 1 an toàn: `key_hash` là `@unique`,
 * nên gửi lại cùng vật liệu là một thao tác idempotent thật, không phải một lời
 * hứa (R24, V4).
 *
 * Hai đường ghi đi hai lối khác nhau, và sự khác nhau đó là chủ đích:
 *
 *   - **Tạo** KHÔNG đổi nội dung cấu hình: snapshot không chứa khoá, `config_hash`
 *     không đổi, không SDK nào cần biết. Nó dùng `$transaction` thường cộng một
 *     advisory lock theo environment (V4). Cho nó đi qua `writeWithOutbox` là tăng
 *     `config_version` của environment cho một thay đổi không ai đọc, và mỗi lần
 *     tạo khoá sẽ bắt mọi replica đi so hash.
 *   - **Thu hồi** ĐỔI ai được vào: mọi replica phải biết, và stream SSE đang mở
 *     bằng khoá đó phải đóng. Nên nó đi qua `writeConfigChange` với
 *     `sdkkey.revoked` (L1): version tiến, hash tính lại (ra đúng số cũ), poller
 *     chiếu dòng này thành no-op. Chính việc hash KHÔNG đổi là tín hiệu hub dùng
 *     để gửi `flag_changed` rỗng thay cho một snapshot đầy đủ.
 */

const NOT_FOUND = "Không tìm thấy SDK key";

/**
 * Đã bị thu hồi bởi một lời gọi khác trong lúc ta đang giữ khoá environment.
 *
 * Sentinel để LÙI transaction, không phải để báo lỗi cho người dùng: lúc này bước
 * 1 của ADR-05 đã tăng `config_version`, và nếu ta commit thì lần thu hồi thứ hai
 * để lại một dòng outbox thứ hai cùng một hàng audit thứ hai cho một thay đổi
 * không xảy ra (AC-4.6 đếm đúng hai con số đó). Ném ra ngoài `$transaction` là
 * cách duy nhất bỏ luôn phần version đã cấp.
 */
class AlreadyRevoked extends Error {
  constructor(readonly revokedAt: Date) {
    super("SDK key đã bị thu hồi bởi một lời gọi khác");
  }
}

/**
 * Tạo khoá (V4) — bắt P2002 NGOÀI transaction rồi chạy lại ĐÚNG MỘT lần.
 *
 * Khe hở tồn tại vì advisory lock chỉ tuần tự hoá các lời gọi ĐI QUA nó: một
 * transaction đã INSERT mà chưa commit là vô hình với `SELECT … WHERE key_hash`
 * ở READ COMMITTED, nên bên thứ hai thấy "chưa có" rồi đụng ràng buộc unique lúc
 * ghi. Lần chạy lại thấy hàng đã commit và trả `created: false`.
 *
 * Vì sao không thử lại trong transaction: một lỗi ràng buộc huỷ cả transaction
 * Postgres (`25P02`), nên sau INSERT hỏng không câu nào chạy được nữa — kể cả câu
 * đọc lại hàng vừa gây lỗi.
 *
 * Đúng MỘT lần, không vòng lặp: lần hai đã đọc trạng thái đã commit, nên một P2002
 * nữa nghĩa là giả định về `@unique` sai — thứ phải nổ ra thành 500 chứ không bị
 * một vòng `while` che đi.
 */
export async function create(
  input: CreateSdkKeyInput,
  audit: AuditContext & { actorUserId: string },
): Promise<SdkKeyStamp> {
  try {
    return await issue(input, audit);
  } catch (err: unknown) {
    if (dbConstraintError(err)?.code !== "DUPLICATE_RESOURCE") throw err;
    return issue(input, audit);
  }
}

async function issue(
  input: CreateSdkKeyInput,
  audit: AuditContext & { actorUserId: string },
): Promise<SdkKeyStamp> {
  return prisma.$transaction(async (tx) => {
    await repository.lockEnvironment(tx, input.environmentId);

    const projectId = await repository.projectIdOf(tx, input.environmentId);
    if (projectId === undefined) {
      throw new NotFoundError("Không tìm thấy environment");
    }

    /**
     * Hàng đã có cùng hash phải khớp CẢ BA trường mới được coi là "chính lời gọi
     * này, lần trước" (V4).
     *
     * Lệch bất kỳ trường nào là một chuyện khác hẳn: cùng một token thô lại được
     * gửi cho một environment khác, một người khác, hay một loại khác. Không có
     * đường hợp lệ nào dẫn tới đó — token sinh từ 32 byte ngẫu nhiên — nên đó là
     * dấu hiệu bên gọi đang gửi lại vật liệu không thuộc về nó, và câu trả lời
     * đúng là 409 chứ không phải "ừ, khoá của bạn đây".
     */
    const existing = await repository.byHash(tx, input.keyHash);
    if (existing !== null) {
      if (
        existing.environmentId !== input.environmentId ||
        existing.createdById !== audit.actorUserId ||
        existing.keyType !== input.keyType
      ) {
        throw new ConflictError(
          "Vật liệu khoá này đã thuộc một khoá khác",
          undefined,
          "DUPLICATE_RESOURCE",
        );
      }
      return { id: existing.id, created: false };
    }

    /**
     * Quota đếm DƯỚI advisory lock (V5, AC-5.1).
     *
     * Đếm ngoài khoá là đúng khe hở mà AC-5.1 bắn vào: 25 lời gọi đồng thời cùng
     * đọc 19, cùng thấy còn chỗ, cùng ghi — và environment kết thúc với 44 khoá
     * sống. Dưới khoá thì lời gọi thứ 21 đọc được đúng 20 và trả 422.
     */
    const active = await repository.countActive(tx, input.environmentId);
    if (active >= SDK_KEY.maxActivePerEnvironment) {
      throw new UnprocessableError(
        `Environment đã có ${String(active)} SDK key đang hoạt động (tối đa ${String(SDK_KEY.maxActivePerEnvironment)}) — thu hồi một khoá cũ rồi thử lại`,
        undefined,
        "QUOTA_EXCEEDED",
      );
    }

    const key = await repository.insert(tx, {
      environmentId: input.environmentId,
      keyType: input.keyType,
      keyHash: input.keyHash,
      keySuffix: input.keySuffix,
      label: input.label,
      createdById: audit.actorUserId,
    });

    /**
     * Audit trong CÙNG transaction (I40) và chỉ mang thứ nhận diện được khoá mà
     * không dùng được nó: loại, đuôi, nhãn.
     *
     * KHÔNG `keyHash`: `audit_logs` là bảng append-only giữ vĩnh viễn và VIEWER
     * đọc được (`GET /projects/:id/audit`). Hash không phải plaintext, nhưng nó
     * là thứ duy nhất database dùng để tra khoá — chép nó sang một bảng nhiều
     * người đọc hơn là hạ mức bảo vệ của chính cột đó mà không được gì. Đuôi 6
     * ký tự trả lời đúng câu mà sổ kiểm toán cần: "khoá NÀO".
     */
    await recordAudit(tx, projectId, {
      ...audit,
      action: "sdkkey.create",
      targetType: "SdkKey",
      targetId: key.id,
      environmentId: input.environmentId,
      after: {
        keyType: input.keyType,
        keySuffix: input.keySuffix,
        label: input.label,
      },
    });

    return { id: key.id, created: true };
  }, SDK_KEY.createTransaction);
}

/**
 * Thu hồi khoá — idempotent (L1, L7, AC-4.6).
 *
 * Đường nhanh ngoài transaction cho khoá ĐÃ thu hồi là đúng đắn, không chỉ là
 * tối ưu: `revoked_at` không bao giờ bị xoá, nên phép đọc ấy đơn điệu — thấy mốc
 * rồi thì không trạng thái nào về sau làm nó biến mất. Nhờ vậy lần gọi thứ hai
 * không khoá environment nào và không tăng `config_version` của ai.
 *
 * Đua thật (hai lời gọi cùng thấy `null`) vẫn được xếp hàng sau khoá hàng
 * environment của bước 1, và bên thua nhận `undefined` từ `revoke` rồi lùi bằng
 * sentinel.
 */
export async function revoke(
  keyId: string,
  environmentId: string,
  audit: AuditContext & { actorUserId: string },
): Promise<SdkKeyRevocation> {
  const target = await repository.targetOf(prisma, keyId, environmentId);
  if (target === null) throw new NotFoundError(NOT_FOUND);
  if (target.revokedAt !== null) {
    return { id: keyId, revokedAt: target.revokedAt, changed: false };
  }

  /**
   * `project_id` của hàng audit đọc NGOÀI transaction: một environment không bao
   * giờ chuyển sang project khác, nên con số này không cần khoá — và một lượt đi
   * về bớt đi là một lượt không nằm trong lúc đang giữ khoá environment.
   */
  const projectId = await repository.projectIdOf(prisma, environmentId);
  if (projectId === undefined) throw new NotFoundError(NOT_FOUND);

  try {
    return await writeConfigChange({
      environmentIds: [environmentId],
      changeType: "sdkkey.revoked",
      actorUserId: audit.actorUserId,
      mutate: async (tx): Promise<SdkKeyRevocation> => {
        const fresh = await repository.targetOf(tx, keyId, environmentId);
        if (fresh === null) throw new NotFoundError(NOT_FOUND);
        if (fresh.revokedAt !== null) throw new AlreadyRevoked(fresh.revokedAt);

        const revokedAt = await repository.revoke(tx, keyId, environmentId);
        if (revokedAt === undefined) {
          throw new Error(
            "revoke: hàng sdk_keys còn sống lúc đọc nhưng UPDATE không chạm hàng nào",
          );
        }

        await recordAudit(tx, projectId, {
          ...audit,
          action: "sdkkey.revoke",
          targetType: "SdkKey",
          targetId: keyId,
          environmentId,
          before: {
            keyType: fresh.keyType,
            keySuffix: fresh.keySuffix,
            label: fresh.label,
            revokedAt: null,
          },
          after: {
            keyType: fresh.keyType,
            keySuffix: fresh.keySuffix,
            label: fresh.label,
            revokedAt,
          },
        });

        return { id: keyId, revokedAt, changed: true };
      },
      /**
       * Nội dung cấu hình không đổi, nên không có gì rút ra từ snapshot: delta do
       * bên gọi đưa, và poller chiếu `sdkkey.revoked` thành KHÔNG phần tử nào
       * (L1). `sdkKeyId` ở đây là thứ hub đọc để đóng đúng stream của khoá ấy.
       */
      stateOf: recomputedStateOf({ sdkKeyId: keyId }),
    });
  } catch (err: unknown) {
    if (err instanceof AlreadyRevoked) {
      return { id: keyId, revokedAt: err.revokedAt, changed: false };
    }
    throw err;
  }
}
