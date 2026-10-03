import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useLocation, useNavigate } from "@tanstack/react-router";
import type { InvitationTargetWire } from "@udp/shared-types/wire";
import { useEffect, useState } from "react";
import { Loading } from "../../components/States";
import { toast } from "../../components/Toast";
import { useMessages } from "../../i18n";
import { messageOf } from "../../lib/errors";
import { formatDateTime } from "../../lib/format";
import { isApiError } from "../../lib/http";
import { qk, qkPrefix } from "../../lib/query-keys";
import { authApi } from "../auth/auth-api";
import { AuthFrame } from "../auth/AuthPages";
import { useAuthStore } from "../auth/auth-store";
import { rolesMessages } from "../project/roles.messages";
import { teamMessages } from "../team/team.messages";
import {
  invitationApi,
  isInvitationToken,
  pendingInvite,
} from "./invitation-api";
import { invitationMessages } from "./invitation.messages";

/** Đích quay lại sau đăng nhập/đăng ký — KHÔNG mang token (token đợi trong sessionStorage của thẻ) */
const BACK = { redirectTo: "/invite" } as const;

/**
 * [Plan #55 QĐ-5] `/invite#<token>` — trang công khai của người cầm đường dẫn mời.
 *
 * Token đến ở fragment (không bao giờ tới máy chủ), được cất vào sessionStorage rồi xoá khỏi thanh địa chỉ: không
 * nằm trong lịch sử trình duyệt, không nằm trong `?redirectTo=` khi người được mời đi đăng nhập hay tạo tài khoản.
 * Ba nhánh: chưa đăng nhập (đăng nhập / tạo tài khoản rồi quay lại), đăng nhập SAI email (đăng xuất), đúng email
 * (nhận ⇒ đi thẳng tới project hay nhóm).
 */
export function InvitePage() {
  const m = useMessages(invitationMessages).page;
  const location = useLocation();
  const navigate = useNavigate();
  const [token] = useState(() => {
    const fromLink = location.hash;
    if (isInvitationToken(fromLink)) {
      pendingInvite.save(fromLink);
      return fromLink;
    }
    const saved = pendingInvite.read();
    return isInvitationToken(saved) ? saved : null;
  });
  useEffect(() => {
    if (location.hash !== "") void navigate({ to: "/invite", replace: true });
  }, [location.hash, navigate]);

  if (token === null) {
    return (
      <AuthFrame title={m.title}>
        <p role="alert">{m.noToken}</p>
        <HomeLink />
      </AuthFrame>
    );
  }
  return <Invitation token={token} />;
}

function HomeLink() {
  const m = useMessages(invitationMessages).page;
  return (
    <p className="c3">
      <Link to="/app/home">{m.home}</Link>
    </p>
  );
}

function Invitation({ token }: { token: string }) {
  const m = useMessages(invitationMessages).page;
  const projectRoles = useMessages(rolesMessages).role;
  const teamRoles = useMessages(teamMessages).role;
  const user = useAuthStore((s) => s.user);
  const clearUser = useAuthStore((s) => s.clearUser);
  const queryClient = useQueryClient();
  const navigate = useNavigate();

  const lookup = useQuery({
    queryKey: qk.invitation(token),
    queryFn: () => invitationApi.lookup(token),
  });
  const gone = isApiError(lookup.error) && lookup.error.status === 404;
  useEffect(() => {
    if (gone) pendingInvite.clear();
  }, [gone]);

  const accept = useMutation({
    mutationFn: () => invitationApi.accept(token),
    onSuccess: async ({ target }) => {
      pendingInvite.clear();
      toast.info(m.joined(target.name));
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: qk.home() }),
        queryClient.invalidateQueries({ queryKey: qkPrefix.projectsAll() }),
        queryClient.invalidateQueries({ queryKey: qk.teams() }),
      ]);
      await (target.kind === "PROJECT"
        ? navigate({
            to: "/app/projects/$projectId",
            params: { projectId: target.id },
            search: {},
          })
        : navigate({
            to: "/app/teams/$teamId",
            params: { teamId: target.id },
          }));
    },
  });

  const signOut = async (): Promise<void> => {
    try {
      await authApi.logout();
    } finally {
      clearUser();
      queryClient.clear();
    }
  };

  const roleOf = (target: InvitationTargetWire): string =>
    target.kind === "PROJECT"
      ? projectRoles[target.projectRole]
      : teamRoles[target.teamRole];

  if (lookup.isPending) {
    return (
      <AuthFrame title={m.title}>
        <Loading />
      </AuthFrame>
    );
  }
  if (lookup.isError) {
    return (
      <AuthFrame title={gone ? m.goneTitle : m.title}>
        <p role="alert">{gone ? m.goneBody : messageOf(lookup.error)}</p>
        <HomeLink />
      </AuthFrame>
    );
  }

  const invitation = lookup.data.invitation;
  const sameAccount =
    user !== null && user.email.toLowerCase() === invitation.email;
  return (
    <AuthFrame title={m.title}>
      <p>
        {m.invited(
          <b>{invitation.invitedBy.name}</b>,
          invitation.target.kind,
          <b translate="no">{invitation.target.name}</b>,
          <b>{roleOf(invitation.target)}</b>,
        )}
      </p>
      <p className="c3">
        {m.forEmail(
          <b translate="no">{invitation.email}</b>,
          formatDateTime(invitation.expiresAt),
        )}
      </p>
      {user === null ? (
        <>
          <p>{m.signInFirst}</p>
          <div className="line">
            <Link to="/login" search={BACK} className="btn pri">
              {m.signIn}
            </Link>
            <Link to="/register" search={BACK} className="btn">
              {m.register}
            </Link>
          </div>
        </>
      ) : sameAccount ? (
        <>
          {accept.isError && (
            <p role="alert" className="field-error">
              {messageOf(accept.error)}
            </p>
          )}
          <button
            type="button"
            className="btn pri"
            disabled={accept.isPending}
            onClick={() => accept.mutate()}
          >
            {accept.isPending ? m.accepting : m.accept}
          </button>
        </>
      ) : (
        <>
          <p role="alert">{m.wrongAccount(user.email, invitation.email)}</p>
          <button type="button" className="btn" onClick={() => void signOut()}>
            {m.signOut}
          </button>
        </>
      )}
    </AuthFrame>
  );
}
