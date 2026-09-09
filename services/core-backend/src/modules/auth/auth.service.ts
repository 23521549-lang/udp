import { randomUUID } from "node:crypto";
import { env } from "@udp/config";
import { ConflictError, UnauthenticatedError } from "../../core/errors.js";
import * as sessions from "./refresh-session.repository.js";
import {
  dummyVerify,
  hashPassword,
  verifyPassword,
} from "../../core/security/password.js";
import {
  signAccessToken,
  signRefreshToken,
  verifyRefreshToken,
} from "../../core/security/tokens.js";
import * as repository from "./auth.repository.js";
import type {
  AuthResult,
  LoginInput,
  PublicUser,
  RegisterInput,
} from "./auth.types.js";

/**
 * Thông báo DUY NHẤT cho mọi trường hợp đăng nhập thất bại.
 *
 * Phân biệt "email không tồn tại" với "sai mật khẩu" biến endpoint đăng nhập
 * thành công cụ liệt kê tài khoản đã đăng ký.
 */
const INVALID_CREDENTIALS = "Email hoặc mật khẩu không đúng";

/**
 * Cấp một cặp token và GHI phiên tương ứng.
 *
 * Thứ tự bắt buộc: sinh id → ký token (token mang id) → ghi hàng (hàng lưu hash
 * của token). Không đảo được, vì hash phụ thuộc token còn token phụ thuộc id.
 */
async function issueTokens(
  user: PublicUser,
  session: { sessionId: string; familyId: string },
  ctx: sessions.SessionContext,
): Promise<AuthResult["tokens"]> {
  const refreshToken = signRefreshToken({
    sub: user.id,
    sid: session.sessionId,
    fid: session.familyId,
  });

  await sessions.record({
    sessionId: session.sessionId,
    familyId: session.familyId,
    userId: user.id,
    token: refreshToken,
    expiresAt: new Date(Date.now() + env.JWT_REFRESH_TTL * 1000),
    ctx,
  });

  return {
    accessToken: signAccessToken({
      sub: user.id,
      email: user.email,
      platformRole: user.platformRole,
      fid: session.familyId,
    }),
    refreshToken,
  };
}

export async function register(
  input: RegisterInput,
  ctx: sessions.SessionContext = {},
): Promise<AuthResult> {
  const existing = await repository.findPublicByEmail(input.email);
  if (existing) throw new ConflictError("Email đã được đăng ký");

  const user = await repository.create({
    email: input.email,
    name: input.name,
    passwordHash: await hashPassword(input.password),
  });

  const family = sessions.newFamily();
  return { user, tokens: await issueTokens(user, family, ctx), familyId: family.familyId };
}

export async function login(input: LoginInput, ctx: sessions.SessionContext = {}): Promise<AuthResult> {
  const record = await repository.findWithPasswordHash(input.email);

  if (!record) {
    // Chạy một phép so sánh giả để nhánh này tốn thời gian tương đương nhánh
    // có thật — nếu không, chênh lệch thời gian phản hồi tiết lộ email nào tồn tại.
    await dummyVerify(input.password);
    throw new UnauthenticatedError(INVALID_CREDENTIALS);
  }

  const { passwordHash, ...user } = record;
  const isValid = await verifyPassword(input.password, passwordHash);
  if (!isValid) throw new UnauthenticatedError(INVALID_CREDENTIALS);

  const family = sessions.newFamily();
  return { user, tokens: await issueTokens(user, family, ctx), familyId: family.familyId };
}

/**
 * Xoay vòng refresh token, và phát hiện tái sử dụng.
 *
 * Ba lớp kiểm, mỗi lớp bắt một thứ khác nhau:
 *
 *  1. Chữ ký JWT — token có phải do ta cấp không.
 *  2. Phiên trong database — token đã bị thu hồi chưa, còn hạn không. Đây là
 *     thứ chữ ký KHÔNG nói được: một token hợp lệ về mặt mã hoá vẫn có thể
 *     thuộc phiên đã đăng xuất.
 *  3. Hash khớp — hàng phiên đúng là hàng của TOKEN NÀY. Không có bước này thì
 *     `sid` là thứ duy nhất ràng buộc, mà `sid` nằm trong payload đã ký nên hai
 *     token cùng `sid` (bản gốc và bản đã xoay) đều qua được.
 *
 * Trình lại một token đã bị thu hồi là bằng chứng có HAI bản sao đang tồn tại.
 * Ta không biết bản nào của người dùng thật, nên thu hồi cả họ và buộc đăng
 * nhập lại. Bất tiện, nhưng đó là phản ứng đúng khi token đã bị nhân bản — và
 * là cách duy nhất phát hiện trộm mà không chờ người dùng báo.
 */
export async function refresh(
  refreshToken: string,
  ctx: sessions.SessionContext = {},
): Promise<AuthResult> {
  const payload = verifyRefreshToken(refreshToken);
  const session = await sessions.findById(payload.sid);

  if (!session || session.userId !== payload.sub) {
    throw new UnauthenticatedError("Phiên đăng nhập không hợp lệ");
  }

  if (session.revokedAt !== null || session.tokenHash !== sessions.hashToken(refreshToken)) {
    await sessions.revokeFamily(session.familyId);
    throw new UnauthenticatedError("Phiên đăng nhập không hợp lệ");
  }

  if (session.expiresAt.getTime() <= Date.now()) {
    throw new UnauthenticatedError("Phiên đăng nhập đã hết hạn");
  }

  // Đọc lại user từ database thay vì tin payload: kể từ lúc token được cấp, tài
  // khoản có thể đã bị xoá hoặc đổi quyền.
  const user = await repository.findPublicById(payload.sub);
  if (!user) throw new UnauthenticatedError("Tài khoản không còn tồn tại");

  const next = { sessionId: randomUUID(), familyId: session.familyId };
  const tokens = await issueTokens(user, next, ctx);
  await sessions.markRotated(session.id, next.sessionId);

  return { user, tokens, familyId: session.familyId };
}

/** Thu hồi phiên phía SERVER — xoá cookie thôi thì token vẫn dùng được */
export async function logout(refreshToken: string | undefined): Promise<void> {
  if (refreshToken === undefined) return;
  try {
    const payload = verifyRefreshToken(refreshToken);
    await sessions.revokeSession(payload.sid);
  } catch {
    // Token hỏng hoặc hết hạn: không có gì để thu hồi, và đăng xuất không được
    // phép thất bại vì lý do đó.
  }
}

export async function getCurrentUser(userId: string): Promise<PublicUser> {
  const user = await repository.findPublicById(userId);
  if (!user) throw new UnauthenticatedError("Tài khoản không còn tồn tại");
  return user;
}
