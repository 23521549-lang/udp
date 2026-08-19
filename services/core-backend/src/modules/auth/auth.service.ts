import { ConflictError, UnauthenticatedError } from "../../core/errors.js";
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

const issueTokens = (user: PublicUser): AuthResult["tokens"] => ({
  accessToken: signAccessToken({
    sub: user.id,
    email: user.email,
    platformRole: user.platformRole,
  }),
  refreshToken: signRefreshToken({ sub: user.id }),
});

export async function register(input: RegisterInput): Promise<AuthResult> {
  const existing = await repository.findPublicByEmail(input.email);
  if (existing) throw new ConflictError("Email đã được đăng ký");

  const user = await repository.create({
    email: input.email,
    name: input.name,
    passwordHash: await hashPassword(input.password),
  });

  return { user, tokens: issueTokens(user) };
}

export async function login(input: LoginInput): Promise<AuthResult> {
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

  return { user, tokens: issueTokens(user) };
}

/**
 * Cấp lại access token từ refresh token.
 *
 * Đọc lại user từ database thay vì tin nội dung token: kể từ lúc token được cấp,
 * tài khoản có thể đã bị xoá hoặc đổi quyền. Tin payload nghĩa là một người vừa
 * bị hạ quyền vẫn giữ quyền cũ suốt 7 ngày.
 */
export async function refresh(refreshToken: string): Promise<AuthResult> {
  const payload = verifyRefreshToken(refreshToken);

  const user = await repository.findPublicById(payload.sub);
  if (!user) throw new UnauthenticatedError("Tài khoản không còn tồn tại");

  return { user, tokens: issueTokens(user) };
}

export async function getCurrentUser(userId: string): Promise<PublicUser> {
  const user = await repository.findPublicById(userId);
  if (!user) throw new UnauthenticatedError("Tài khoản không còn tồn tại");
  return user;
}
