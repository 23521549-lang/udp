import { createHash, randomUUID } from "node:crypto";
import { ACTOR_HEADER, env, INTERNAL_SECRET_HEADER } from "@udp/config";
import type { PrismaClient } from "@udp/db";
import request from "supertest";

/**
 * Fixture dùng chung cho test của Service 2 (app trong tiến trình) và của provider
 * (Service 2 là tiến trình con) [v4.7: chuyển từ `services/flag-service/tests`].
 */

/** Đích của lời gọi: app Express trong tiến trình HOẶC `baseUrl` của tiến trình con */
export type HttpTarget = Parameters<typeof request>[0];

/**
 * Chủ của project fixture — user CŨ NHẤT, không phải "một user bất kỳ".
 *
 * `findFirst` không `orderBy` trả hàng theo thứ tự vật lý mà Postgres đang giữ,
 * và thứ tự đó không được bảo đảm. `pnpm -r test` chạy core-backend SONG SONG
 * với flag-service trên cùng một database, và core-backend tạo user tạm rồi dọn
 * chúng cùng mọi thứ gắn với chúng khi xong. Nhặt nhầm đúng user tạm ấy làm chủ
 * thì project fixture của file này biến mất giữa chừng — đã thấy đúng hình dạng
 * đó: 65/65 test xanh, rồi `afterAll` nhận `P2025` vì project không còn để xoá.
 *
 * User cũ nhất là user của seed: được tạo trước mọi test, và không test nào
 * dọn nó. `findFirstOrThrow` thì ném rõ ràng nếu database chưa có user nào —
 * tức là seed chưa chạy — thay vì để test hỏng ở một chỗ khó hiểu hơn.
 */
export function stableOwner(admin: PrismaClient): Promise<{ id: string }> {
  return admin.user.findFirstOrThrow({
    select: { id: true },
    orderBy: { createdAt: "asc" },
  });
}

/** Một lời gọi `/internal/*` đã gắn bí mật và người làm */
export const internalCall = (
  req: request.Test,
  actorId: string,
): request.Test =>
  req
    .set(INTERNAL_SECRET_HEADER, env.INTERNAL_SERVICE_SECRET)
    .set(ACTOR_HEADER, actorId);

/**
 * [v4.6] Tạo flag qua route THẬT rồi KÍCH HOẠT nó (DRAFT → ACTIVE, cũng qua route).
 *
 * Flag DRAFT không vào snapshot (§6.7: SDK chưa nhận), nên mọi test đọc snapshot,
 * delta hay `/sdk/config` về một flag phải dùng flag đã kích hoạt — tạo xong đọc
 * ngay là đọc một flag không có mặt. Kích hoạt qua route (không UPDATE bằng owner)
 * để lần đổi đi đúng ADR-05: có version, có outbox, hash khớp.
 *
 * Trả response của lần kích hoạt: `body.flag` cùng hình với response tạo.
 */
export async function createActiveFlag(
  target: HttpTarget,
  actorId: string,
  body: Record<string, unknown>,
): Promise<request.Response> {
  const created = await internalCall(
    request(target).post("/internal/flags"),
    actorId,
  )
    .send(body)
    .expect(201);
  return internalCall(
    request(target).patch(`/internal/flags/${created.body.flag.id as string}`),
    actorId,
  )
    .send({
      lastKnownUpdatedAt: created.body.flag.updatedAt as string,
      lifecycleStatus: "ACTIVE",
    })
    .expect(200);
}

export const sha256 = (value: string): string =>
  createHash("sha256").update(value).digest("hex");

export type SdkKeyType = "SERVER" | "CLIENT";

/** Token thô đúng hình của S1 (`udp_sk_…` / `udp_ck_…`), duy nhất mỗi lần gọi */
export const newSdkKeyToken = (keyType: SdkKeyType): string =>
  `udp_${keyType === "SERVER" ? "sk" : "ck"}_test_${randomUUID()}`;

export interface SdkKeySpec {
  token: string;
  environmentId: string;
  keyType: SdkKeyType;
  createdById: string;
  label?: string;
  /** Khoá đã thu hồi từ đầu — ca 401 */
  revokedAt?: Date;
}

/**
 * Hàng `sdk_keys` cho một token thô — database chỉ giữ `sha256` và 6 ký tự cuối,
 * như S1 sẽ làm (CRUD SDK key ở S1 là #23). Dùng với `createMany` khi test cần
 * nhiều khoá cố định (khác env, khác loại, đã thu hồi).
 */
export function sdkKeyData(spec: SdkKeySpec) {
  return {
    environmentId: spec.environmentId,
    keyType: spec.keyType,
    keyHash: sha256(spec.token),
    keySuffix: spec.token.slice(-6),
    label: spec.label ?? "test",
    createdById: spec.createdById,
    ...(spec.revokedAt === undefined ? {} : { revokedAt: spec.revokedAt }),
  };
}

/** Phát hành MỘT SDK key mới cho environment — trả token thô */
export async function issueSdkKey(
  admin: PrismaClient,
  options: Omit<SdkKeySpec, "token">,
): Promise<string> {
  const token = newSdkKeyToken(options.keyType);
  await admin.sdkKey.create({ data: sdkKeyData({ ...options, token }) });
  return token;
}
