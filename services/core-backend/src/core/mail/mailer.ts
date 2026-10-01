import nodemailer from "nodemailer";

/**
 * [v4.12, Plan #60 QĐ-7] Thư gửi đi của Service 1 — hôm nay chỉ thư đặt lại mật khẩu. Qua SMTP (`SMTP_URL`) để không
 * buộc vào nhà cung cấp nào: gói miễn phí của Brevo, Resend hay Gmail đều nói SMTP. Test tiêm bản giả ghi thư vào bộ
 * nhớ (`AppDeps.auth.mailer`), không bao giờ gửi thư thật.
 */
export interface OutgoingMail {
  to: string;
  subject: string;
  text: string;
  html: string;
}

export interface Mailer {
  send(mail: OutgoingMail): Promise<void>;
}

export function smtpMailer(url: string, from: string): Mailer {
  const transport = nodemailer.createTransport(url);
  return {
    async send(mail) {
      await transport.sendMail({ from, ...mail });
    },
  };
}
