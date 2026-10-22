import { Router } from "express";
import {
  asyncHandler,
  ForbiddenError,
  NotFoundError,
  requireInternalCaller,
  sendJson,
  ServiceUnavailableError,
  uuidParam,
  validateBody,
} from "@udp/http";
import {
  internalClusterTokenBodyWire,
  internalClusterTokenResponseWire,
  type InternalClusterTokenBody,
} from "@udp/shared-types/wire";
import { appDepsOf } from "../core/app-deps.js";
import { PhaseFailedError } from "../jobs/job-kit.js";
import {
  clampExpiry,
  ISSUABLE_IDENTITIES,
} from "../modules/cluster/cluster-token.js";

/**
 * `POST /internal/clusters/:id/token` (ADR-06, §9 Internal) [Plan #51 QĐ-2] — Service 3 xin bound SA token để tự
 * nói với cluster của project (promote/abort `Rollout`, đọc `Canary`), không bao giờ chạm credential cloud.
 *
 * `:id` là id PROJECT: UDP không có bảng cluster, mỗi project BYOC có đúng một cluster (cùng khoá mà
 * `ClusterAccessCache` dùng). Chỉ cấp `traffic` — xem `ISSUABLE_IDENTITIES`. Token không ghi log, không ghi
 * database (I24); hạn trả về ≤ 1 giờ (I24c).
 */
export const internalClusterTokenRouter: Router = Router();

internalClusterTokenRouter.post(
  "/clusters/:id/token",
  requireInternalCaller,
  validateBody(internalClusterTokenBodyWire),
  asyncHandler(async (req, res) => {
    const projectId = uuidParam(req, "id", "Mã cluster không hợp lệ");
    const { serviceAccount } = req.body as InternalClusterTokenBody;
    if (!ISSUABLE_IDENTITIES.has(serviceAccount)) {
      throw new ForbiddenError(
        `Route này chỉ cấp token của udp-traffic (§12.2, T12) — không cấp "${serviceAccount}"`,
      );
    }
    const issue = appDepsOf(req).provisioning.clusterToken;
    if (issue === null) {
      throw new ServiceUnavailableError(
        "Tiến trình này không chạy worker — không có đường tới cluster",
      );
    }
    // Lỗi gốc KHÔNG đi ra: lỗi của SDK cloud có thể mang credential (§12 T3, I12)
    const issued = await issue(projectId, serviceAccount).catch(
      (err: unknown) => {
        throw err instanceof PhaseFailedError
          ? new NotFoundError(`Không cấp được token: ${err.message}`)
          : new ServiceUnavailableError("Không xin được token từ cluster");
      },
    );
    sendJson(res, internalClusterTokenResponseWire, {
      apiEndpoint: issued.apiEndpoint,
      caData: issued.caData,
      token: issued.token,
      expiresAt: clampExpiry(issued.expiresAt, Date.now()).toISOString(),
    });
  }),
);
