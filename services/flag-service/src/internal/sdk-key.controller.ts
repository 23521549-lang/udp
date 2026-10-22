import { Router, type Request } from "express";
import {
  asyncHandler,
  uuidParam,
  validateBody,
  validateQuery,
} from "@udp/http";
import {
  auditContextOf,
  requireInternalCaller,
} from "../auth/internal-auth.guard.js";
import * as sdkKeyService from "../modules/sdk-key/sdk-key.service.js";
import {
  createSdkKeySchema,
  revokeSdkKeyQuerySchema,
  type RevokeSdkKeyQuery,
} from "../modules/sdk-key/sdk-key.types.js";

/**
 * Hai route `/internal/sdk-keys` (§3.2, §9, L7) [v4.9].
 *
 * Router này mount SAU parser 1 MB toàn cục của `app.ts`, khác hẳn
 * `/internal/segments`: thân của nó là năm trường ngắn (một uuid, một enum, một
 * nhãn ≤ 100 ký tự, 64 và 6 ký tự hex) — dưới 300 byte. Không có lý do nào cho
 * một parser riêng ở đây, và thêm một parser thứ hai lệch khỏi khuôn là thêm một
 * chỗ để lệch (V15).
 *
 * Response của POST mang `created` và một status khác nhau cho hai ca (V4). Nó
 * KHÔNG mang plaintext, và không thể mang: Service 2 chưa từng nhận plaintext.
 */
export const internalSdkKeyRouter: Router = Router();

const keyIdOf = (req: Request): string =>
  uuidParam(req, "id", "Mã SDK key không hợp lệ");

const environmentIdOf = (req: Request): string =>
  (req.query as unknown as RevokeSdkKeyQuery).environmentId;

/**
 * 201 khi vừa INSERT, 200 khi hàng cùng `key_hash` đã có (V4).
 *
 * Hai status cho hai chuyện khác nhau: lần thử lại của Service 1 sau timeout phải
 * biết rằng KHÔNG có gì mới được ghi — không hàng audit mới, không một suất quota
 * nữa. Trả 201 cho cả hai là nói dối với bên gọi về chuyện đã xảy ra trong
 * database, và AC-5.5 đếm đúng chỗ đó.
 */
internalSdkKeyRouter.post(
  "/sdk-keys",
  requireInternalCaller,
  validateBody(createSdkKeySchema),
  asyncHandler(async (req, res) => {
    const key = await sdkKeyService.create(req.body, auditContextOf(req));
    res.status(key.created ? 201 : 200).json({
      key: { id: key.id },
      created: key.created,
    });
  }),
);

/**
 * `validateQuery` TRƯỚC handler: `environmentId` là phép kiểm sở hữu (R05), và
 * thiếu nó thì không có gì hợp lệ để thu hồi.
 */
internalSdkKeyRouter.delete(
  "/sdk-keys/:id",
  requireInternalCaller,
  validateQuery(revokeSdkKeyQuerySchema),
  asyncHandler(async (req, res) => {
    const key = await sdkKeyService.revoke(
      keyIdOf(req),
      environmentIdOf(req),
      auditContextOf(req),
    );
    res.json({
      key: { id: key.id, revokedAt: key.revokedAt },
      changed: key.changed,
    });
  }),
);
