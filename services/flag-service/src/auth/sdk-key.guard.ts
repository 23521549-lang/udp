import { createHash } from "node:crypto";
import type { Request, RequestHandler } from "express";
import type { SdkKeyType } from "@udp/db";
import { asyncHandler, UnauthenticatedError } from "@udp/http";
import { prisma } from "../core/db.js";

/**
 * Xác thực SDK key và suy ra environment (§9, ADR-03, T1).
 *
 * "project và environment được suy ra TỪ KEY, không từ query param" — §9 nói
 * đúng chữ đó. `projectId` là UUID hiện trong URL của Portal nên KHÔNG phải bí
 * mật; nhận nó từ client rồi phục vụ cấu hình theo nó là biến một mã không bí
 * mật thành thẻ ra vào. Bất biến I14 sống ở đây và ở `snapshotOf`, không ở đâu
 * khác.
 */

export interface ResolvedSdkKey {
  id: string;
  environmentId: string;
  keyType: SdkKeyType;
}

/**
 * Danh tính đã giải, gắn theo request qua `WeakMap` chứ không gắn lên `req`.
 *
 * Mở rộng `Express.Request` bằng một trường tuỳ chọn thì mọi nơi đọc nó phải
 * viết `req.sdkKey!` — mà `no-non-null-assertion` cấm trong `src/**`, và cấm có
 * lý do: dấu `!` ở đó là một lời hứa rằng guard đã chạy, do người viết route giữ
 * chứ không do kiểu giữ. `WeakMap` cho cùng tiện ích mà không nói dối: chưa qua
 * guard thì `sdkKeyOf` ném, và ném ở lần chạy đầu tiên chứ không phục vụ nhầm.
 *
 * `WeakMap` chứ không `Map`: khoá là đối tượng request, nên mục tự biến mất khi
 * request được thu hồi. `Map` ở đây là một chỗ rò bộ nhớ tăng theo lưu lượng.
 */
const resolved = new WeakMap<Request, ResolvedSdkKey>();

const BEARER = /^Bearer (.+)$/;

/**
 * MỘT thông điệp cho MỌI ca hỏng — thiếu header, sai định dạng, khoá lạ, khoá đã
 * thu hồi, khoá đúng nhưng sai loại.
 *
 * Phân biệt chúng là nói cho người dò biết họ đã đi đúng bao xa: "khoá không tồn
 * tại" và "khoá đã thu hồi" gộp lại còn là một kênh dò xem chuỗi nào từng là
 * khoá thật. `internal-auth.guard.ts` đã đặt khuôn này cho bí mật nội bộ; chép
 * nguyên chứ không nghĩ lại.
 */
const reject = (): UnauthenticatedError =>
  new UnauthenticatedError("SDK key không hợp lệ");

/**
 * Không cần `timingSafeEqual` ở đây, và lý do phải nói rõ để không ai "sửa" lại.
 *
 * Thứ được đem đi tra là `sha256(token)`, nên thời gian phản hồi chỉ tiết lộ
 * thông tin về HASH chứ không về token, và không ai đi ngược được preimage của
 * sha256. `key_hash` lại là `@unique`, nên tra cứu là một lần dò index: thời
 * gian phẳng bất kể khớp hay không.
 *
 * Thứ PHẢI tránh là thêm một phép so thứ hai ở tầng JavaScript sau khi tra —
 * `row.keyHash === computed` — vì phép so chuỗi của JS thoát sớm ở byte đầu tiên
 * lệch. Nó không thêm an toàn nào (database vừa so xong rồi) mà mở lại đúng kênh
 * bên vừa nói là không có.
 */
const hashOf = (token: string): string =>
  createHash("sha256").update(token).digest("hex");

/**
 * KHÔNG cache kết quả tra khoá trong lát cắt này — và đây là lựa chọn, không
 * phải bỏ sót.
 *
 * Đã đo: một lần tra tốn ~52ms qua kết nối pooled, tức nó là chi phí lớn nhất
 * còn lại của `/sdk/config` sau khi snapshot đã nằm trong cache. Cache được thì
 * nhanh hơn hẳn. Nhưng cache khoá xác thực nghĩa là một khoá vừa bị THU HỒI vẫn
 * dùng được cho tới hết TTL, và thu hồi là hành động an ninh — người bấm nút đó
 * đang tin rằng nó có hiệu lực ngay.
 *
 * Ngưỡng để đổi ý, ghi ra để lần sau không phải đoán: `RATE_LIMIT.sdk.perKey`
 * chặn ở 100 request mỗi phút cho mỗi khoá, tức ~1,7 request/giây/khoá. Pool 5
 * khe chịu được ~96 truy vấn/giây. Nên chừng nào số khoá HOẠT ĐỘNG ĐỒNG THỜI
 * còn dưới khoảng 50, tra thẳng vẫn dư sức. Vượt mốc đó thì cách đúng là
 * invalidate theo `change_type = "sdkkey.revoked"` qua chính change feed — chứ
 * không phải một TTL đoán mò.
 *
 * Cùng lý do, `last_used_at` (và `SDK_KEY.lastUsedThrottleMs`) chưa được ghi:
 * hôm nay chưa có màn hình nào đọc nó, nên nó chỉ là một lệnh ghi thêm trên
 * đường đọc nóng.
 */
async function lookup(token: string): Promise<ResolvedSdkKey | null> {
  const row = await prisma.sdkKey.findUnique({
    where: { keyHash: hashOf(token) },
    select: {
      id: true,
      environmentId: true,
      keyType: true,
      revokedAt: true,
    },
  });

  if (row === null || row.revokedAt !== null) return null;

  return {
    id: row.id,
    environmentId: row.environmentId,
    keyType: row.keyType,
  };
}

/**
 * Chỉ cho ĐÚNG một loại khoá đi qua.
 *
 * Loại khoá là tham số bắt buộc chứ không phải tuỳ chọn, vì ADR-03 phân đôi bề
 * mặt theo đúng trục này: `/sdk/config` trả rule đầy đủ nên **CHỈ** dành cho
 * `SERVER` key — §9 viết "CLIENT key không bao giờ chạm endpoint này". Khoá
 * `CLIENT` đi vào đây là toàn bộ tập rule rời server xuống trình duyệt, tức là
 * vỡ I11 và T1. Một guard "xác thực xong rồi tính sau" sẽ để đúng chuyện đó xảy
 * ra, nên phép kiểm loại khoá nằm TRONG guard, không nằm ở handler.
 */
export function requireSdkKey(allowed: SdkKeyType): RequestHandler {
  return asyncHandler(async (req, _res, next) => {
    const header = req.get("Authorization");
    const token =
      header === undefined ? null : (BEARER.exec(header)?.[1] ?? null);

    if (token === null || token.length === 0) {
      next(reject());
      return;
    }

    const key = await lookup(token);
    if (key === null || key.keyType !== allowed) {
      next(reject());
      return;
    }

    resolved.set(req, key);
    next();
  });
}

/** Danh tính đã giải. Ném nếu `requireSdkKey` chưa chạy trên request này */
export function sdkKeyOf(req: Request): ResolvedSdkKey {
  const key = resolved.get(req);
  if (key === undefined) {
    throw new Error(
      "sdkKeyOf gọi trên request chưa qua requireSdkKey — sai thứ tự middleware",
    );
  }
  return key;
}
