import type { InvitationTargetWire } from "@udp/shared-types/wire";
import type { ReactNode } from "react";
import { defineMessages } from "../../i18n";

type TargetKind = InvitationTargetWire["kind"];

/** [Plan #55] Chữ của lời mời: trang nhận lời mời, hộp đường dẫn, danh sách lời mời đang chờ */
export const invitationMessages = defineMessages({
  vi: {
    page: {
      title: "Lời mời",
      noToken:
        "Đường dẫn mời không đầy đủ. Mở lại đúng đường dẫn bạn nhận được.",
      goneTitle: "Lời mời không còn hiệu lực",
      goneBody:
        "Đường dẫn có thể đã được dùng, đã bị thu hồi hoặc đã hết hạn. Nhờ người mời gửi đường dẫn mới.",
      invited: (
        inviter: ReactNode,
        kind: TargetKind,
        name: ReactNode,
        role: ReactNode,
      ) => (
        <>
          {inviter} mời bạn vào {kind === "PROJECT" ? "project" : "nhóm"} {name}{" "}
          với vai {role}.
        </>
      ),
      forEmail: (email: ReactNode, expires: string) => (
        <>
          Lời mời dành cho {email}, hết hạn {expires}.
        </>
      ),
      signInFirst:
        "Đăng nhập hoặc tạo tài khoản bằng đúng email này để nhận lời mời.",
      signIn: "Đăng nhập",
      register: "Tạo tài khoản",
      wrongAccount: (current: string, invited: string) =>
        `Bạn đang đăng nhập bằng ${current}. Lời mời dành cho ${invited}: đăng xuất rồi đăng nhập bằng đúng email.`,
      signOut: "Đăng xuất",
      accept: "Nhận lời mời",
      accepting: "Đang nhận…",
      joined: (name: string) => `Đã vào ${name}`,
      home: "Về trang chủ",
    },
    link: {
      title: "Đường dẫn mời",
      body: (email: string) =>
        `${email} chưa có tài khoản UDP. Gửi đường dẫn này cho họ qua kênh bạn vẫn dùng (chat, email).`,
      label: "Đường dẫn mời",
      copy: "Chép đường dẫn",
      note: "Đường dẫn chỉ hiện một lần, hết hạn sau 7 ngày, và chỉ tài khoản dùng đúng email này nhận được. Tạo lại đường dẫn thì đường dẫn cũ hết dùng được.",
      done: "Xong",
    },
    pending: {
      title: "Lời mời đang chờ",
      label: "Lời mời đang chờ",
      byAndExpiry: (inviter: string, expires: string) =>
        `${inviter} mời · hết hạn ${expires}`,
      expired: "Đã hết hạn",
      reissue: "Tạo lại đường dẫn",
      reissueOf: (email: string) => `Tạo lại đường dẫn mời ${email}`,
      revoke: "Thu hồi",
      revokeOf: (email: string) => `Thu hồi lời mời của ${email}`,
      revoked: (email: string) => `Đã thu hồi lời mời của ${email}`,
    },
  },
  en: {
    page: {
      title: "Invitation",
      noToken:
        "This invitation link is incomplete. Open the exact link you received.",
      goneTitle: "This invitation is no longer valid",
      goneBody:
        "The link may have been used, revoked or expired. Ask the person who invited you for a new link.",
      invited: (
        inviter: ReactNode,
        kind: TargetKind,
        name: ReactNode,
        role: ReactNode,
      ) => (
        <>
          {inviter} invited you to the {kind === "PROJECT" ? "project" : "team"}{" "}
          {name} as {role}.
        </>
      ),
      forEmail: (email: ReactNode, expires: string) => (
        <>
          The invitation is for {email} and expires {expires}.
        </>
      ),
      signInFirst:
        "Sign in or create an account with this exact email to accept the invitation.",
      signIn: "Sign in",
      register: "Create account",
      wrongAccount: (current: string, invited: string) =>
        `You are signed in as ${current}. The invitation is for ${invited}: sign out, then sign in with that email.`,
      signOut: "Sign out",
      accept: "Accept invitation",
      accepting: "Accepting…",
      joined: (name: string) => `You joined ${name}`,
      home: "Go to home",
    },
    link: {
      title: "Invitation link",
      body: (email: string) =>
        `${email} has no UDP account yet. Send them this link through any channel you already use (chat, email).`,
      label: "Invitation link",
      copy: "Copy link",
      note: "The link is shown only once, expires in 7 days, and only an account with this exact email can accept it. Creating a new link disables the old one.",
      done: "Done",
    },
    pending: {
      title: "Pending invitations",
      label: "Pending invitations",
      byAndExpiry: (inviter: string, expires: string) =>
        `Invited by ${inviter} · expires ${expires}`,
      expired: "Expired",
      reissue: "New link",
      reissueOf: (email: string) => `Create a new invitation link for ${email}`,
      revoke: "Revoke",
      revokeOf: (email: string) => `Revoke the invitation for ${email}`,
      revoked: (email: string) => `Revoked the invitation for ${email}`,
    },
  },
});
