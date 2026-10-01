import { randomBytes } from "node:crypto";
import type { Request } from "express";
import { AUTH } from "@udp/config";
import { logger, NotFoundError } from "@udp/http";
import type { Mailer } from "../../core/mail/mailer.js";
import { hashPassword } from "../../core/security/password.js";
import { hashToken } from "../../core/security/token-hash.js";
import { auditEntry } from "../audit/audit.service.js";
import * as repository from "./auth.repository.js";
import * as sessions from "./refresh-session.repository.js";
import type { ForgotPasswordInput, ResetPasswordInput } from "./auth.types.js";

/**
 * [v4.12, Plan #60 QĐ-7] Quên mật khẩu.
 *
 * Xin thư LUÔN trả cùng một kết quả, dù email có tài khoản hay không: khác nhau là biến route này thành công cụ dò
 * email đã đăng ký. Thư gửi SAU khi trả lời (không chờ SMTP) để thời gian phản hồi cũng không khác nhau. Token chỉ lưu
 * dạng băm, dùng một lần, sống `AUTH.passwordResetTtlMinutes` phút, và nằm ở FRAGMENT của đường dẫn trong thư — phần
 * không bao giờ tới máy chủ, nên không vào log của proxy hay của Service 1.
 */

/** Đường dẫn trong thư, và mọi trường hợp token không dùng được: một câu, không nói vì sao (sai, đã dùng, hết hạn) */
const GONE =
  "Đường dẫn đặt lại mật khẩu không còn dùng được. Xin một thư mới ở trang Quên mật khẩu.";

export async function requestReset(
  input: ForgotPasswordInput,
  mailer: Mailer,
  portalOrigin: string,
): Promise<void> {
  const user = await repository.findPublicByEmail(input.email);
  if (user === null) return;

  const token = randomBytes(AUTH.passwordResetTokenBytes).toString("base64url");
  await repository.issueResetToken(
    user.id,
    hashToken(token),
    new Date(Date.now() + AUTH.passwordResetTtlMinutes * 60_000),
  );
  const mail = resetMail(user.name, `${portalOrigin}/reset-password#${token}`);
  // Không chờ: thời gian trả lời không được lộ email nào có tài khoản. Gửi hỏng thì log — người dùng xin lại được
  void mailer
    .send({ to: user.email, ...mail })
    .catch((err: unknown) =>
      logger.error(
        { err, userId: user.id },
        "gửi thư đặt lại mật khẩu thất bại",
      ),
    );
}

export async function resetPassword(
  input: ResetPasswordInput,
  request: Request,
): Promise<void> {
  const userId = await repository.consumeResetToken(
    hashToken(input.token),
    await hashPassword(input.password),
    (id) => ({
      projectId: null,
      ...auditEntry({
        action: "auth.password.reset",
        targetType: "User",
        targetId: id,
        request,
      }),
    }),
  );
  if (userId === null) throw new NotFoundError(GONE);
  // Ai đang giữ phiên cũ bị đăng xuất ở lần refresh kế tiếp
  await sessions.revokeAllForUser(userId);
}

/** Thư hai ngôn ngữ (UDP chưa biết người nhận dùng ngôn ngữ nào): tiếng Việt trước, tiếng Anh sau */
export function resetMail(
  name: string,
  link: string,
): { subject: string; text: string; html: string } {
  const minutes = String(AUTH.passwordResetTtlMinutes);
  const text = [
    `Chào ${name},`,
    "",
    "Có người (hy vọng là bạn) vừa xin đặt lại mật khẩu tài khoản UDP của bạn. Mở đường dẫn dưới đây để đặt mật khẩu mới:",
    link,
    `Đường dẫn dùng được một lần, trong ${minutes} phút. Nếu bạn không xin, bỏ qua thư này: mật khẩu không đổi.`,
    "",
    "---",
    "",
    `Hi ${name},`,
    "",
    "Someone (hopefully you) asked to reset the password of your UDP account. Open the link below to choose a new one:",
    link,
    `The link works once, for ${minutes} minutes. If you did not ask, ignore this email: your password stays the same.`,
  ].join("\n");
  const esc = (s: string) =>
    s
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  const a = `<a href="${esc(link)}">${esc(link)}</a>`;
  const html = [
    `<p>Chào ${esc(name)},</p>`,
    "<p>Có người (hy vọng là bạn) vừa xin đặt lại mật khẩu tài khoản UDP của bạn. Mở đường dẫn dưới đây để đặt mật khẩu mới:</p>",
    `<p>${a}</p>`,
    `<p>Đường dẫn dùng được một lần, trong ${minutes} phút. Nếu bạn không xin, bỏ qua thư này: mật khẩu không đổi.</p>`,
    "<hr>",
    `<p>Hi ${esc(name)},</p>`,
    "<p>Someone (hopefully you) asked to reset the password of your UDP account. Open the link below to choose a new one:</p>",
    `<p>${a}</p>`,
    `<p>The link works once, for ${minutes} minutes. If you did not ask, ignore this email: your password stays the same.</p>`,
  ].join("\n");
  return {
    subject: "Đặt lại mật khẩu UDP · Reset your UDP password",
    text,
    html,
  };
}
