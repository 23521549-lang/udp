import jwt from "jsonwebtoken";
import { env } from "@udp/config";
import type { PlatformRole } from "@udp/db";
import { UnauthenticatedError } from "../errors.js";

const ISSUER = "udp";

export interface AccessTokenPayload {
  /** userId — dùng tên `sub` theo chuẩn JWT */
  sub: string;
  email: string;
  platformRole: PlatformRole;
}

export interface RefreshTokenPayload {
  sub: string;
}

export const signAccessToken = (payload: AccessTokenPayload): string =>
  jwt.sign(payload, env.JWT_ACCESS_SECRET, {
    expiresIn: env.JWT_ACCESS_TTL,
    issuer: ISSUER,
  });

export const signRefreshToken = (payload: RefreshTokenPayload): string =>
  jwt.sign(payload, env.JWT_REFRESH_SECRET, {
    expiresIn: env.JWT_REFRESH_TTL,
    issuer: ISSUER,
  });

/**
 * Access và refresh dùng HAI secret khác nhau là có chủ đích: lộ một cái không
 * cho phép giả mạo cái kia. Đồng thời chặn được việc dùng nhầm refresh token
 * như access token — chữ ký sẽ không khớp.
 */
export function verifyAccessToken(token: string): AccessTokenPayload {
  try {
    return jwt.verify(token, env.JWT_ACCESS_SECRET, {
      issuer: ISSUER,
    }) as AccessTokenPayload;
  } catch {
    // Không để lộ lý do cụ thể (hết hạn / sai chữ ký / sai issuer) ra ngoài —
    // thông tin đó chỉ giúp kẻ tấn công dò cấu hình.
    throw new UnauthenticatedError("Phiên đăng nhập không hợp lệ");
  }
}

export function verifyRefreshToken(token: string): RefreshTokenPayload {
  try {
    return jwt.verify(token, env.JWT_REFRESH_SECRET, {
      issuer: ISSUER,
    }) as RefreshTokenPayload;
  } catch {
    throw new UnauthenticatedError("Phiên đăng nhập đã hết hạn");
  }
}
