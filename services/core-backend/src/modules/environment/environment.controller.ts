import { Router, type Request } from "express";
import {
  asyncHandler,
  sendJson,
  uuidParam,
  validateBody,
  validateQuery,
} from "@udp/http";
import {
  createEnvironmentBodySchema,
  updateEnvironmentBodySchema,
  type CreateEnvironmentBody,
  type UpdateEnvironmentBody,
} from "@udp/shared-types/environment-api";
import {
  environmentCreatedResponseWire,
  environmentDeletedResponseWire,
  environmentListResponseWire,
  environmentResponseWire,
  sdkKeyCreatedResponseWire,
  sdkKeyListResponseWire,
  sdkKeyResponseWire,
} from "@udp/shared-types/wire";
import { appDepsOf } from "../../core/app-deps.js";
import { requireAuth } from "../../core/http/middlewares/auth.middleware.js";
import { idempotent } from "../../core/http/middlewares/idempotency.middleware.js";
import {
  projectIdParam,
  requireMinProjectRole,
} from "../../core/http/middlewares/project-role.middleware.js";
import { auditContextOf } from "../audit/audit.service.js";
import { environmentWire } from "../project/project.view.js";
import * as environmentService from "./environment.service.js";
import * as sdkKeyService from "./sdk-key.service.js";
import {
  createSdkKeyBodySchema,
  listSdkKeysQuerySchema,
  type CreateSdkKeyBody,
  type ListSdkKeysQuery,
} from "./sdk-key.types.js";

/**
 * SDK key của một environment (§3.1, L7), gắn dưới `/projects/:id` [v4.9].
 *
 * Quyền theo L7: đọc VIEWER, tạo và thu hồi OWNER. OWNER — không MAINTAINER — vì
 * một khoá SERVER đọc được TOÀN BỘ rule và `userIds` của environment qua
 * `/sdk/config`, và nó sống tới khi ai đó thu hồi. Đó là quyết định cấp phát
 * credential, cùng hạng với chuyển quyền sở hữu project, không cùng hạng với sửa
 * một rule.
 *
 * Ba thứ KHÔNG có ở route tạo, mỗi thứ là một chốt của R04:
 *
 *   - **Không `idempotent()`.** Middleware đó lưu nguyên thân response 2xx vào
 *     `idempotency_keys.response_body` rồi phát lại trong 24 giờ — tức plaintext
 *     nằm trong database, đúng thứ dòng 973 của thiết kế cấm. Một `Idempotency-Key`
 *     do client gửi vì thế bị BỎ QUA ở đây, không bị từ chối: nó vô hại, và một
 *     lint riêng (P9) canh rằng chuỗi `idempotent(` không bao giờ xuất hiện trong
 *     chuỗi middleware này.
 *   - **`Cache-Control: no-store` + `Pragma: no-cache`.** Response duy nhất trong
 *     cả API mang một bí mật dùng được ngay; thiếu hai header này thì một proxy
 *     hay chính trình duyệt có thể giữ lại nó.
 *   - **Không parser riêng.** Thân là hai trường ngắn, nên parser 1 MB toàn cục là
 *     dư — khác hẳn đường ghi segment (V15).
 */
export const environmentRouter: Router = Router({ mergeParams: true });

const environmentIdOf = (req: Request): string =>
  uuidParam(req, "envId", "Mã environment không hợp lệ");

const keyIdOf = (req: Request): string =>
  uuidParam(req, "keyId", "Mã SDK key không hợp lệ");

/**
 * Đường dẫn viết bằng CHUỖI TRỰC TIẾP ở cả ba route, không qua một hằng số hay
 * template literal.
 *
 * Đây là điều kiện để lint I10 (`project-route-guard`) nhìn thấy chúng: nó đọc
 * `router.method("<chuỗi>", …)` để dựng danh sách route của vùng project rồi kiểm
 * từng chuỗi middleware. Một đường dẫn ghép bằng biến thì không khớp vị từ, và khi
 * đó route THOÁT khỏi lint mà lint vẫn xanh — đúng hình dạng R25 (b). Ba chuỗi
 * lặp phần `/environments/:envId/keys` là cái giá đã cân: rẻ hơn một route không
 * ai canh.
 */
environmentRouter.get(
  "/environments/:envId/keys",
  requireAuth,
  requireMinProjectRole("VIEWER"),
  validateQuery(listSdkKeysQuerySchema),
  asyncHandler(async (req, res) => {
    sendJson(
      res,
      sdkKeyListResponseWire,
      await sdkKeyService.list(
        projectIdParam(req),
        environmentIdOf(req),
        req.query as unknown as ListSdkKeysQuery,
      ),
    );
  }),
);

environmentRouter.post(
  "/environments/:envId/keys",
  requireAuth,
  requireMinProjectRole("OWNER"),
  validateBody(createSdkKeyBodySchema),
  asyncHandler(async (req, res) => {
    const created = await sdkKeyService.create(
      appDepsOf(req),
      projectIdParam(req),
      environmentIdOf(req),
      req.body as CreateSdkKeyBody,
      auditContextOf(req),
    );
    /**
     * Đặt header TRƯỚC khi ghi thân: `res.json` gửi header đi cùng lúc, nên một
     * `res.set` sau đó là một lệnh không có tác dụng mà không ai báo lỗi.
     */
    res.set("Cache-Control", "no-store").set("Pragma", "no-cache");
    sendJson(res, sdkKeyCreatedResponseWire, created, 201);
  }),
);

environmentRouter.delete(
  "/environments/:envId/keys/:keyId",
  requireAuth,
  requireMinProjectRole("OWNER"),
  asyncHandler(async (req, res) => {
    /**
     * 200 kèm khoá đã thu hồi, không 204: Portal hiện ngay `status` và `revokedAt`
     * mới mà không phải tải lại danh sách — và với một thao tác idempotent, mốc
     * trong response là cách duy nhất người dùng biết lần thu hồi thật đã xảy ra
     * lúc nào (AC-4.6).
     */
    sendJson(
      res,
      sdkKeyResponseWire,
      await sdkKeyService.revoke(
        appDepsOf(req),
        projectIdParam(req),
        environmentIdOf(req),
        keyIdOf(req),
        auditContextOf(req),
      ),
    );
  }),
);

/**
 * [v4.11, Plan #40] Vòng đời environment (§9): đọc VIEWER; tạo, sửa cờ, xoá OWNER — cùng hạng
 * với phát SDK key: thêm một ranh giới cô lập (namespace, khoá, cấu hình flag) là quyết định của
 * chủ project. `POST` qua `idempotent()` như mọi POST tạo tài nguyên khác (§9) — response không
 * mang bí mật nào.
 */
const environmentDepsOf = (req: Request) => {
  const deps = appDepsOf(req);
  return {
    flagService: deps.flagService,
    enqueue: deps.provisioning.enqueue,
  };
};

environmentRouter.get(
  "/environments",
  requireAuth,
  requireMinProjectRole("VIEWER"),
  asyncHandler(async (req, res) => {
    const environments = await environmentService.list(projectIdParam(req));
    sendJson(res, environmentListResponseWire, {
      environments: environments.map(environmentWire),
    });
  }),
);

environmentRouter.post(
  "/environments",
  requireAuth,
  requireMinProjectRole("OWNER"),
  idempotent("POST /projects/:id/environments"),
  validateBody(createEnvironmentBodySchema),
  asyncHandler(async (req, res) => {
    const { environment, job } = await environmentService.create(
      environmentDepsOf(req),
      projectIdParam(req),
      req.body as CreateEnvironmentBody,
      req,
    );
    sendJson(
      res,
      environmentCreatedResponseWire,
      { environment: environmentWire(environment), job },
      201,
    );
  }),
);

environmentRouter.patch(
  "/environments/:envId",
  requireAuth,
  requireMinProjectRole("OWNER"),
  validateBody(updateEnvironmentBodySchema),
  asyncHandler(async (req, res) => {
    const environment = await environmentService.update(
      projectIdParam(req),
      environmentIdOf(req),
      req.body as UpdateEnvironmentBody,
      req,
    );
    sendJson(res, environmentResponseWire, {
      environment: environmentWire(environment),
    });
  }),
);

/** Có cluster ⇒ 202 kèm job dọn phần cluster; không ⇒ 200 `job: null` — một hình response */
environmentRouter.delete(
  "/environments/:envId",
  requireAuth,
  requireMinProjectRole("OWNER"),
  asyncHandler(async (req, res) => {
    const job = await environmentService.remove(
      environmentDepsOf(req),
      projectIdParam(req),
      environmentIdOf(req),
      req,
    );
    sendJson(
      res,
      environmentDeletedResponseWire,
      { job },
      job === null ? 200 : 202,
    );
  }),
);
