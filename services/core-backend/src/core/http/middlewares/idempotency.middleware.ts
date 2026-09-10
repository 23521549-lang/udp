import { createHash } from "node:crypto";
import type { RequestHandler, Response } from "express";
import { prisma } from "../../db.js";
import { UnprocessableError, ValidationError } from "@udp/http";
import { logger } from "@udp/http";
import { requireUser } from "./auth.middleware.js";
import { projectIdParam } from "./project-role.middleware.js";

/**
 * Header `Idempotency-Key` (§9).
 *
 * §9 nói header này áp cho "mọi POST tạo tài nguyên tốn tiền hoặc không đảo
 * ngược được", và liệt kê `POST /projects/:id/members` trong đó với lý do "gửi
 * hai lời mời". Ngữ nghĩa cũng do §9 chốt: cùng key **cùng** body trả lại đúng
 * response cũ kèm `Idempotency-Replayed: true` — chứ không phải 409, vì người
 * bấm hai lần do mạng chậm không đáng bị báo lỗi; cùng key **khác** body trả
 * 422, vì đó là lỗi lập trình của client.
 *
 * Header là TUỲ CHỌN, không bắt buộc. §9 gọi unique index ở tầng database là
 * "lớp chặn thứ hai, phòng khi key hết hạn hoặc client quên gửi" — tức là thiết
 * kế đã lường trước việc client không gửi. Bắt buộc nó sẽ làm hỏng mọi client
 * hiện có mà không đổi lại được tính chất nào, vì lớp thứ hai vẫn ở đó.
 */

const TTL_MS = 24 * 60 * 60 * 1000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Băm body theo dạng chuẩn hoá, không phải `JSON.stringify` thẳng.
 *
 * Cùng một body gửi lại với thứ tự khoá khác — chuyện bình thường khi client
 * dựng object từ nhiều nhánh — sẽ ra chuỗi khác, và người dùng nhận 422 cho một
 * request y hệt cái vừa gửi. Sắp khoá đệ quy làm cho phép so sánh nói về NỘI
 * DUNG chứ không về cách tuần tự hoá.
 */
function canonical(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(canonical);
  return Object.fromEntries(
    Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => [k, canonical(v)]),
  );
}

const hashOf = (body: unknown): string =>
  createHash("sha256")
    .update(JSON.stringify(canonical(body) ?? null))
    .digest("hex");

/**
 * Ghi lại response, rồi MỚI gửi đi.
 *
 * Bọc `res.json` là cách duy nhất lấy được body sau khi handler chạy xong mà
 * không bắt mọi handler phải tự biết đến idempotency.
 *
 * Việc gửi bị hoãn tới khi khoá đã nằm bền vững trong database. Bản đầu tôi
 * viết fire-and-forget cho "khỏi chậm đường đi chính" — sai, và sai đúng chỗ
 * quan trọng nhất: người bấm hai lần cách nhau vài trăm mili giây là CA MÀ
 * TÍNH NĂNG NÀY SINH RA ĐỂ LO, mà đó cũng chính là lúc bản ghi chưa kịp hạ
 * cánh. Bảo đảm sẽ im lặng không có tác dụng đúng lúc cần nó nhất.
 *
 * Nếu ghi hỏng thì vẫn gửi response: mất khả năng phát lại là suy giảm về phía
 * an toàn, còn nuốt mất một hành động đã thực hiện thì không.
 */
function captureResponse(
  res: Response,
  row: {
    projectId: string;
    userId: string;
    endpoint: string;
    key: string;
    bodyHash: string;
  },
): void {
  const original = res.json.bind(res);

  res.json = (body: unknown): Response => {
    if (res.statusCode < 200 || res.statusCode >= 300) return original(body);

    void (async () => {
      try {
        /**
         * `create`, KHÔNG phải `upsert`: `udp_s1` không có quyền UPDATE trên
         * bảng này, có chủ đích — một hàng ở đây là bản ghi "lần đầu đã trả về
         * đúng cái này", sửa được nó nghĩa là một request sau đổi được thứ mà
         * request phát lại nhận. `upsert` sẽ nhận `42501` ngay khi gặp hàng cũ.
         *
         * Hàng quá hạn đã được dọn trước đó trong cùng request, nên khả năng
         * đụng unique index chỉ còn là hai request song song cùng khoá.
         */
        await prisma.idempotencyKey.create({
          data: {
            projectId: row.projectId,
            userId: row.userId,
            endpoint: row.endpoint,
            idempotencyKey: row.key,
            bodyHash: row.bodyHash,
            responseStatus: res.statusCode,
            responseBody: body as never,
            expiresAt: new Date(Date.now() + TTL_MS),
          },
        });
      } catch (err: unknown) {
        logger.warn(
          { err, endpoint: row.endpoint },
          "Không lưu được khoá idempotency",
        );
      }
      original(body);
    })();

    return res;
  };
}

/**
 * Dọn hàng quá hạn ngay trên đường ghi.
 *
 * Thay cho một cron: hạ tầng `jobs/` của §3.1 chưa tồn tại, và một job mồ côi
 * mà không ai nhớ còn tệ hơn. Phạm vi giới hạn trong cùng `(project, endpoint)`
 * nên chi phí bị chặn trên, và nó chỉ chạy đúng lúc có tải thật.
 */
async function sweepExpired(
  projectId: string,
  endpoint: string,
): Promise<void> {
  try {
    await prisma.idempotencyKey.deleteMany({
      where: { projectId, endpoint, expiresAt: { lt: new Date() } },
    });
  } catch (err: unknown) {
    logger.warn({ err }, "Không dọn được khoá idempotency quá hạn");
  }
}

/**
 * @param endpoint Mẫu đường dẫn, ví dụ `POST /projects/:id/members`. Dùng mẫu
 *   chứ không dùng URL thật: cùng một key ở hai project khác nhau là hai ý định
 *   khác nhau, và `project_id` đã nằm riêng trong khoá.
 */
export const idempotent =
  (endpoint: string): RequestHandler =>
  (req, res, next) => {
    void (async () => {
      const raw = req.get("Idempotency-Key");
      if (raw === undefined || raw.length === 0) {
        next();
        return;
      }

      if (!UUID.test(raw)) {
        next(new ValidationError("Idempotency-Key phải là UUID"));
        return;
      }

      // Middleware này luôn chạy sau requireAuth và requireMinProjectRole, nên
      // cả hai giá trị dưới đây đã được xác thực.
      const projectId = projectIdParam(req);
      const userId = requireUser(req).sub;
      const bodyHash = hashOf(req.body);

      const existing = await prisma.idempotencyKey.findUnique({
        where: {
          projectId_userId_endpoint_idempotencyKey: {
            projectId,
            userId,
            endpoint,
            idempotencyKey: raw,
          },
        },
        select: {
          bodyHash: true,
          responseStatus: true,
          responseBody: true,
          expiresAt: true,
        },
      });

      if (existing !== null && existing.expiresAt.getTime() > Date.now()) {
        if (existing.bodyHash !== bodyHash) {
          next(
            new UnprocessableError(
              "Idempotency-Key đã dùng cho một nội dung khác",
              undefined,
              "IDEMPOTENCY_KEY_REUSED",
            ),
          );
          return;
        }

        res.set("Idempotency-Replayed", "true");
        res.status(existing.responseStatus).json(existing.responseBody);
        return;
      }

      await sweepExpired(projectId, endpoint);
      captureResponse(res, { projectId, userId, endpoint, key: raw, bodyHash });
      next();
    })().catch(next);
  };
