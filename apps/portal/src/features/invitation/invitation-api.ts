import { useRouter } from "@tanstack/react-router";
import {
  INVITATION_TOKEN_PATTERN,
  invitationAcceptedResponseWire,
  invitationLookupResponseWire,
  projectInvitationCreatedResponseWire,
  projectInvitationListResponseWire,
  teamInvitationCreatedResponseWire,
  teamInvitationListResponseWire,
  type GrantableProjectRoleWire,
  type TeamRoleWire,
} from "@udp/shared-types/wire";
import { api } from "../../lib/http";

/**
 * [Plan #55 QĐ-1] Lời mời bằng đường dẫn. Token đi trong THÂN request, không bao giờ trong URL của API.
 */
export const invitationApi = {
  ofProject: (projectId: string) =>
    api(
      projectInvitationListResponseWire,
      `/projects/${projectId}/invitations`,
    ),
  inviteToProject: (
    projectId: string,
    body: { email: string; projectRole: GrantableProjectRoleWire },
  ) =>
    api(
      projectInvitationCreatedResponseWire,
      `/projects/${projectId}/invitations`,
      { method: "POST", body },
    ),
  revokeInProject: (projectId: string, invitationId: string) =>
    api(null, `/projects/${projectId}/invitations/${invitationId}`, {
      method: "DELETE",
    }),
  ofTeam: (teamId: string) =>
    api(teamInvitationListResponseWire, `/teams/${teamId}/invitations`),
  inviteToTeam: (
    teamId: string,
    body: { email: string; teamRole: TeamRoleWire },
  ) =>
    api(teamInvitationCreatedResponseWire, `/teams/${teamId}/invitations`, {
      method: "POST",
      body,
    }),
  revokeInTeam: (teamId: string, invitationId: string) =>
    api(null, `/teams/${teamId}/invitations/${invitationId}`, {
      method: "DELETE",
    }),
  lookup: (token: string) =>
    api(invitationLookupResponseWire, "/invitations/lookup", {
      method: "POST",
      body: { token },
    }),
  accept: (token: string) =>
    api(invitationAcceptedResponseWire, "/invitations/accept", {
      method: "POST",
      body: { token },
    }),
};

export const isInvitationToken = (value: string | null): value is string =>
  value !== null && INVITATION_TOKEN_PATTERN.test(value);

/**
 * Đường dẫn mời đầy đủ: token nằm ở FRAGMENT (`/invite#<token>`). Trình duyệt không bao giờ gửi fragment lên máy
 * chủ, nên token không vào log truy cập của máy phục vụ Portal, không vào header Referer. `createHref` của history
 * đang dùng lo phần còn lại — `/invite#…` với history trình duyệt, `#/invite#…` với hash history của bản xem thử.
 */
export function useInviteLinkOf(): (token: string) => string {
  const router = useRouter();
  return (token) =>
    new URL(
      router.history.createHref(`/invite#${token}`),
      window.location.href,
    ).toString();
}

/**
 * Token của lời mời đang mở, giữ trong sessionStorage của THẺ này trong lúc người được mời đăng nhập hay tạo tài
 * khoản — nhờ vậy đích quay lại chỉ là `/invite`, không bao giờ mang token lên URL (`?redirectTo=` thì có đi lên
 * máy chủ). Kho bị chặn (chế độ riêng tư) ⇒ giữ trong bộ nhớ của trang, vẫn đủ cho đăng nhập không tải lại trang.
 */
const STORAGE_KEY = "udp_invite_token";
let memory: string | null = null;

export const pendingInvite = {
  save(token: string): void {
    memory = token;
    try {
      sessionStorage.setItem(STORAGE_KEY, token);
    } catch {
      // bộ nhớ của trang đã giữ
    }
  },
  read(): string | null {
    try {
      return sessionStorage.getItem(STORAGE_KEY) ?? memory;
    } catch {
      return memory;
    }
  },
  clear(): void {
    memory = null;
    try {
      sessionStorage.removeItem(STORAGE_KEY);
    } catch {
      // không có gì để xoá
    }
  },
};
