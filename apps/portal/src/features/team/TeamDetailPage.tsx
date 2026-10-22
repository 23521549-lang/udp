import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useParams } from "@tanstack/react-router";
import type {
  TeamDetailWire,
  TeamInvitationWire,
  TeamMemberWire,
  TeamRoleWire,
} from "@udp/shared-types/wire";
import { useState } from "react";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { PageHead } from "../../components/PageHead";
import { ErrorState, Loading } from "../../components/States";
import { toast } from "../../components/Toast";
import { useMessages } from "../../i18n";
import { fieldErrorsOf, messageOf } from "../../lib/errors";
import { isApiError } from "../../lib/http";
import { qk, qkPrefix } from "../../lib/query-keys";
import { useAuthStore } from "../auth/auth-store";
import { invitationApi } from "../invitation/invitation-api";
import { InviteLinkDialog } from "../invitation/InviteLinkDialog";
import { PendingInvitations } from "../invitation/PendingInvitations";
import { invitationMessages } from "../invitation/invitation.messages";
import { rolesMessages } from "../project/roles.messages";
import { teamApi } from "./team-api";
import { teamMessages } from "./team.messages";

const TEAM_ROLES: readonly TeamRoleWire[] = ["MEMBER", "OWNER"];

/**
 * [Plan #55 QĐ-5] `/app/teams/:teamId` — thành viên, lời mời đang chờ, project nhóm có quyền, và cài đặt nhóm.
 * Người ngoài nhóm nhận 404 từ máy chủ (không dò được nhóm nào có thật); chỉ chủ nhóm thấy nút sửa.
 */
export function TeamDetailPage() {
  const t = useMessages(teamMessages);
  const { teamId } = useParams({ from: "/app/teams/$teamId" });
  const team = useQuery({
    queryKey: qk.team(teamId),
    queryFn: () => teamApi.get(teamId),
  });
  // Tên nhóm là dữ liệu người dùng (không dịch); lúc còn tải thì tiêu đề là chữ của Portal
  const name = team.data?.team.name;
  const title =
    name === undefined ? t.detail.all : <span translate="no">{name}</span>;

  return (
    <>
      <div className="bar">
        <div className="crumbs">
          <Link to="/app/teams" className="c3">
            {t.detail.all}
          </Link>
          <span className="sep">/</span>
          <b>{title}</b>
        </div>
      </div>
      <div className="scroll">
        <PageHead title={title} />
        <div className="page">
          {team.isPending ? (
            <Loading />
          ) : team.isError ? (
            <ErrorState
              error={team.error}
              onRetry={() => void team.refetch()}
              back={<Link to="/app/teams">{t.detail.all}</Link>}
            />
          ) : (
            <TeamBody team={team.data.team} />
          )}
        </div>
      </div>
    </>
  );
}

function TeamBody({ team }: { team: TeamDetailWire }) {
  const t = useMessages(teamMessages);
  const projectRoles = useMessages(rolesMessages).role;
  const isOwner = team.myRole === "OWNER";
  return (
    <>
      <Members team={team} />
      {isOwner && <TeamInvitations teamId={team.id} />}
      <h2 className="h2">{t.detail.projectsTitle}</h2>
      {team.projects.length === 0 ? (
        <p className="c3">{t.detail.projectsEmpty}</p>
      ) : (
        <div className="lst" role="list" aria-label={t.detail.projectsLabel}>
          {team.projects.map((p) => (
            <div role="listitem" key={p.id}>
              <Link
                to="/app/projects/$projectId"
                params={{ projectId: p.id }}
                search={{}}
              >
                <span className="t lst-name" translate="no">
                  {p.name}
                </span>
                <span className="lst-end chip soft">
                  {projectRoles[p.projectRole]}
                </span>
              </Link>
            </div>
          ))}
        </div>
      )}
      {isOwner && <TeamSettings team={team} />}
    </>
  );
}

function Members({ team }: { team: TeamDetailWire }) {
  const t = useMessages(teamMessages);
  const m = t.detail;
  const me = useAuthStore((s) => s.user);
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<TeamRoleWire>("MEMBER");
  const [link, setLink] = useState<{ email: string; token: string } | null>(
    null,
  );
  /** userId của chính người đang xem khi họ bấm "Rời nhóm" — nút chỉ có ở dòng của họ */
  const [leaving, setLeaving] = useState<string | null>(null);
  const isOwner = team.myRole === "OWNER";
  const refresh = async (): Promise<void> => {
    await queryClient.invalidateQueries({ queryKey: qk.team(team.id) });
    await queryClient.invalidateQueries({ queryKey: qk.teams() });
  };

  /**
   * "Mời" thêm thẳng người đã có tài khoản; email chưa có tài khoản (404) thì tạo lời mời bằng đường dẫn và hiện
   * đường dẫn đó — một nút cho cả hai trường hợp, người mời không phải biết trước.
   */
  const add = useMutation({
    mutationFn: async (): Promise<{ email: string; token?: string }> => {
      try {
        await teamApi.addMember(team.id, { email, teamRole: role });
        return { email };
      } catch (error) {
        if (!isApiError(error) || error.status !== 404) throw error;
        const created = await invitationApi.inviteToTeam(team.id, {
          email,
          teamRole: role,
        });
        return { email: created.invitation.email, token: created.token };
      }
    },
    onSuccess: async (result) => {
      setEmail("");
      if (result.token === undefined) toast.info(m.added);
      else setLink({ email: result.email, token: result.token });
      await refresh();
      await queryClient.invalidateQueries({
        queryKey: qk.teamInvitations(team.id),
      });
    },
  });
  const addErrors = fieldErrorsOf(add.error);

  const update = useMutation({
    mutationFn: (v: { member: TeamMemberWire; role: TeamRoleWire }) =>
      teamApi.updateMember(team.id, v.member.userId, v.role),
    onSuccess: async (_d, v) => {
      toast.info(m.roleChanged(v.member.user.email, t.role[v.role]));
      await refresh();
    },
    onError: (e) => toast.error(messageOf(e)),
  });
  const remove = useMutation({
    mutationFn: (member: TeamMemberWire) =>
      teamApi.removeMember(team.id, member.userId),
    onSuccess: async (_d, member) => {
      toast.info(m.removed(member.user.email));
      await refresh();
    },
    onError: (e) => toast.error(messageOf(e)),
  });
  const leave = useMutation({
    mutationFn: (userId: string) => teamApi.removeMember(team.id, userId),
    onSuccess: async () => {
      setLeaving(null);
      toast.info(m.left(team.name));
      queryClient.removeQueries({ queryKey: qk.team(team.id) });
      // Quyền đến từ nhóm mất ngay: danh sách project và trang chủ phải đọc lại
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: qk.teams() }),
        queryClient.invalidateQueries({ queryKey: qk.home() }),
        queryClient.invalidateQueries({ queryKey: qkPrefix.projectsAll() }),
      ]);
      await navigate({ to: "/app/teams" });
    },
  });

  return (
    <section aria-label={m.membersTitle}>
      <h2 className="h2">{m.membersTitle}</h2>
      {isOwner && (
        <form
          className="line"
          style={{ marginBottom: 14 }}
          onSubmit={(e) => {
            e.preventDefault();
            add.mutate();
          }}
        >
          <input
            className="inp"
            type="email"
            name="email"
            inputMode="email"
            autoComplete="off"
            spellCheck={false}
            aria-label={m.newEmail}
            aria-invalid={addErrors.email !== undefined}
            aria-describedby={add.isError ? "team-add-err" : undefined}
            placeholder={m.newEmailPlaceholder}
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
          <select
            className="sel"
            aria-label={m.newRole}
            value={role}
            onChange={(e) => setRole(e.target.value as TeamRoleWire)}
          >
            {TEAM_ROLES.map((r) => (
              <option key={r} value={r}>
                {t.role[r]}
              </option>
            ))}
          </select>
          <button
            type="submit"
            className="btn pri"
            disabled={email === "" || add.isPending}
          >
            {m.invite}
          </button>
          {add.isError && (
            <span id="team-add-err" className="field-error" role="alert">
              {addErrors.email ?? messageOf(add.error)}
            </span>
          )}
        </form>
      )}
      <div className="lst" role="list" aria-label={m.membersLabel}>
        {team.members.map((x) => {
          const self = x.userId === me?.id;
          return (
            <div key={x.userId} className="it" role="listitem">
              <b className="lst-name">
                {x.user.name}
                {self && <span className="c3"> ({m.you})</span>}
              </b>
              <span className="c3" translate="no">
                {x.user.email}
              </span>
              <span className="lst-end">
                {isOwner ? (
                  <select
                    className="sel"
                    aria-label={m.roleOf(x.user.email)}
                    value={x.teamRole}
                    disabled={update.isPending}
                    onChange={(e) =>
                      update.mutate({
                        member: x,
                        role: e.target.value as TeamRoleWire,
                      })
                    }
                  >
                    {TEAM_ROLES.map((r) => (
                      <option key={r} value={r}>
                        {t.role[r]}
                      </option>
                    ))}
                  </select>
                ) : (
                  t.role[x.teamRole]
                )}
              </span>
              {self ? (
                <button
                  type="button"
                  className="btn"
                  onClick={() => setLeaving(x.userId)}
                >
                  {m.leave}
                </button>
              ) : (
                isOwner && (
                  <button
                    type="button"
                    className="btn danger"
                    aria-label={m.removeOf(x.user.email)}
                    disabled={remove.isPending}
                    onClick={() => remove.mutate(x)}
                  >
                    {m.remove}
                  </button>
                )
              )}
            </div>
          );
        })}
      </div>
      {link !== null && (
        <InviteLinkDialog
          email={link.email}
          token={link.token}
          onClose={() => setLink(null)}
        />
      )}
      {leaving !== null && (
        <ConfirmDialog
          title={m.leaveTitle}
          description={m.leaveBody}
          confirmLabel={m.leave}
          danger
          busy={leave.isPending}
          error={leave.isError ? messageOf(leave.error) : undefined}
          onConfirm={() => leave.mutate(leaving)}
          onClose={() => {
            setLeaving(null);
            leave.reset();
          }}
        />
      )}
    </section>
  );
}

function TeamInvitations({ teamId }: { teamId: string }) {
  const t = useMessages(teamMessages);
  const pending = useMessages(invitationMessages).pending;
  const queryClient = useQueryClient();
  const [link, setLink] = useState<{ email: string; token: string } | null>(
    null,
  );
  const invitations = useQuery({
    queryKey: qk.teamInvitations(teamId),
    queryFn: () => invitationApi.ofTeam(teamId),
  });
  const refresh = () =>
    queryClient.invalidateQueries({ queryKey: qk.teamInvitations(teamId) });

  const reissue = useMutation({
    mutationFn: (x: TeamInvitationWire) =>
      invitationApi.inviteToTeam(teamId, {
        email: x.email,
        teamRole: x.teamRole,
      }),
    onSuccess: async (created) => {
      setLink({ email: created.invitation.email, token: created.token });
      await refresh();
    },
    onError: (e) => toast.error(messageOf(e)),
  });
  const revoke = useMutation({
    mutationFn: (x: TeamInvitationWire) =>
      invitationApi.revokeInTeam(teamId, x.id),
    onSuccess: async (_d, x) => {
      toast.info(pending.revoked(x.email));
      await refresh();
    },
    onError: (e) => toast.error(messageOf(e)),
  });

  if (invitations.data === undefined) return null;
  return (
    <>
      <PendingInvitations
        items={invitations.data.invitations}
        roleOf={(x) => t.role[x.teamRole]}
        busy={reissue.isPending || revoke.isPending}
        onReissue={(x) => reissue.mutate(x)}
        onRevoke={(x) => revoke.mutate(x)}
      />
      {link !== null && (
        <InviteLinkDialog
          email={link.email}
          token={link.token}
          onClose={() => setLink(null)}
        />
      )}
    </>
  );
}

function TeamSettings({ team }: { team: TeamDetailWire }) {
  const m = useMessages(teamMessages).detail;
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [name, setName] = useState(team.name);
  const [deleting, setDeleting] = useState(false);

  const rename = useMutation({
    mutationFn: () => teamApi.rename(team.id, name.trim()),
    onSuccess: async () => {
      toast.info(m.renamed);
      await queryClient.invalidateQueries({ queryKey: qk.team(team.id) });
      await queryClient.invalidateQueries({ queryKey: qk.teams() });
    },
  });
  const remove = useMutation({
    mutationFn: () => teamApi.remove(team.id),
    onSuccess: async () => {
      setDeleting(false);
      toast.info(m.deleted(team.name));
      queryClient.removeQueries({ queryKey: qk.team(team.id) });
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: qk.teams() }),
        queryClient.invalidateQueries({ queryKey: qk.home() }),
        queryClient.invalidateQueries({ queryKey: qkPrefix.projectsAll() }),
      ]);
      await navigate({ to: "/app/teams" });
    },
  });
  const errors = fieldErrorsOf(rename.error);

  return (
    <section aria-label={m.settingsTitle}>
      <h2 className="h2">{m.settingsTitle}</h2>
      <form
        className="line"
        onSubmit={(e) => {
          e.preventDefault();
          rename.mutate();
        }}
      >
        <input
          className="inp"
          name="name"
          autoComplete="off"
          maxLength={80}
          aria-label={m.name}
          aria-invalid={errors.name !== undefined}
          aria-describedby={rename.isError ? "team-rename-err" : undefined}
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <button
          type="submit"
          className="btn"
          disabled={
            name.trim() === "" || name.trim() === team.name || rename.isPending
          }
        >
          {m.rename}
        </button>
        <button
          type="button"
          className="btn danger"
          onClick={() => setDeleting(true)}
        >
          {m.delete}
        </button>
        {rename.isError && (
          <span id="team-rename-err" className="field-error" role="alert">
            {errors.name ?? messageOf(rename.error)}
          </span>
        )}
      </form>
      {deleting && (
        <ConfirmDialog
          title={m.deleteTitle}
          description={m.deleteBody}
          confirmLabel={m.delete}
          danger
          typeToConfirm={team.name}
          busy={remove.isPending}
          error={remove.isError ? messageOf(remove.error) : undefined}
          onConfirm={() => remove.mutate()}
          onClose={() => {
            setDeleting(false);
            remove.reset();
          }}
        />
      )}
    </section>
  );
}
