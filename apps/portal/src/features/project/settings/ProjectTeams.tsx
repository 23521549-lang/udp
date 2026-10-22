import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import type {
  GrantableProjectRoleWire,
  ProjectTeamWire,
} from "@udp/shared-types/wire";
import { useState } from "react";
import { ErrorState, Loading } from "../../../components/States";
import { toast } from "../../../components/Toast";
import { useMessages } from "../../../i18n";
import { messageOf } from "../../../lib/errors";
import { qk } from "../../../lib/query-keys";
import { projectTeamApi, teamApi } from "../../team/team-api";
import { teamMessages } from "../../team/team.messages";
import { rolesMessages } from "../roles.messages";

const GRANTABLE: readonly GrantableProjectRoleWire[] = [
  "MAINTAINER",
  "DEVELOPER",
  "VIEWER",
];

/**
 * [Plan #55 QĐ-5] Nhóm có quyền trên project, KÈM người của từng nhóm — ai xem được project thì thấy mọi người vào
 * được nó. Chỉ OWNER cấp, đổi vai, gỡ; nhóm để cấp là nhóm CỦA người đang xem (máy chủ đòi người cấp thuộc nhóm).
 */
export function ProjectTeams({
  projectId,
  isOwner,
}: {
  projectId: string;
  isOwner: boolean;
}) {
  const t = useMessages(teamMessages);
  const m = t.project;
  const roles = useMessages(rolesMessages).role;
  const queryClient = useQueryClient();
  const granted = useQuery({
    queryKey: qk.projectTeams(projectId),
    queryFn: () => projectTeamApi.list(projectId),
  });
  const refresh = async (): Promise<void> => {
    await queryClient.invalidateQueries({
      queryKey: qk.projectTeams(projectId),
    });
    await queryClient.invalidateQueries({ queryKey: qk.teams() });
  };

  const update = useMutation({
    mutationFn: (v: {
      team: ProjectTeamWire;
      role: GrantableProjectRoleWire;
    }) => projectTeamApi.update(projectId, v.team.teamId, v.role),
    onSuccess: async (_d, v) => {
      toast.info(m.roleChanged(v.team.name, roles[v.role]));
      await refresh();
    },
    onError: (e) => toast.error(messageOf(e)),
  });
  const revoke = useMutation({
    mutationFn: (team: ProjectTeamWire) =>
      projectTeamApi.revoke(projectId, team.teamId),
    onSuccess: async (_d, team) => {
      toast.info(m.revoked(team.name));
      await refresh();
    },
    onError: (e) => toast.error(messageOf(e)),
  });

  return (
    <section aria-label={m.title}>
      <h2 className="h2">{m.title}</h2>
      <p className="c3">{m.lead}</p>
      {granted.isPending ? (
        <Loading />
      ) : granted.isError ? (
        <ErrorState
          error={granted.error}
          onRetry={() => void granted.refetch()}
        />
      ) : (
        <>
          {isOwner && (
            <GrantForm
              projectId={projectId}
              grantedIds={granted.data.teams.map((x) => x.teamId)}
              onGranted={refresh}
            />
          )}
          {granted.data.teams.length === 0 ? (
            <p className="c3">{m.empty}</p>
          ) : (
            <div className="lst" role="list" aria-label={m.label}>
              {granted.data.teams.map((x) => (
                <div key={x.teamId} className="it" role="listitem">
                  <b className="lst-name" translate="no">
                    {x.name}
                  </b>
                  <span
                    className="c3"
                    title={x.members.map((p) => p.email).join(", ")}
                  >
                    {m.people(x.members.length)}:{" "}
                    {x.members.map((p) => p.name).join(", ")}
                  </span>
                  <span className="lst-end">
                    {isOwner ? (
                      <select
                        className="sel"
                        aria-label={m.roleOf(x.name)}
                        value={x.projectRole}
                        disabled={update.isPending}
                        onChange={(e) =>
                          update.mutate({
                            team: x,
                            role: e.target.value as GrantableProjectRoleWire,
                          })
                        }
                      >
                        {GRANTABLE.map((r) => (
                          <option key={r} value={r}>
                            {roles[r]}
                          </option>
                        ))}
                      </select>
                    ) : (
                      roles[x.projectRole]
                    )}
                  </span>
                  {isOwner && (
                    <button
                      type="button"
                      className="btn danger"
                      aria-label={m.revokeOf(x.name)}
                      disabled={revoke.isPending}
                      onClick={() => revoke.mutate(x)}
                    >
                      {m.revoke}
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </section>
  );
}

function GrantForm({
  projectId,
  grantedIds,
  onGranted,
}: {
  projectId: string;
  grantedIds: readonly string[];
  onGranted: () => Promise<void>;
}) {
  const t = useMessages(teamMessages);
  const m = t.project;
  const roles = useMessages(rolesMessages).role;
  const mine = useQuery({ queryKey: qk.teams(), queryFn: teamApi.list });
  const candidates = (mine.data?.teams ?? []).filter(
    (x) => !grantedIds.includes(x.id),
  );
  const [picked, setPicked] = useState("");
  const [role, setRole] = useState<GrantableProjectRoleWire>("DEVELOPER");
  const teamId = picked !== "" ? picked : (candidates[0]?.id ?? "");

  const grant = useMutation({
    mutationFn: () =>
      projectTeamApi.grant(projectId, { teamId, projectRole: role }),
    onSuccess: async ({ team }) => {
      setPicked("");
      toast.info(m.granted(team.name));
      await onGranted();
    },
  });

  if (mine.data === undefined) return null;
  if (mine.data.teams.length === 0) {
    return (
      <p className="c3">
        {m.noTeams} <Link to="/app/teams">{m.openTeams}</Link>
      </p>
    );
  }
  if (candidates.length === 0) return <p className="c3">{m.allGranted}</p>;
  return (
    <form
      className="line"
      style={{ marginBottom: 14 }}
      onSubmit={(e) => {
        e.preventDefault();
        grant.mutate();
      }}
    >
      <select
        className="sel"
        aria-label={m.team}
        value={teamId}
        onChange={(e) => setPicked(e.target.value)}
      >
        {candidates.map((x) => (
          <option key={x.id} value={x.id}>
            {x.name}
          </option>
        ))}
      </select>
      <select
        className="sel"
        aria-label={m.teamRole}
        value={role}
        onChange={(e) => setRole(e.target.value as GrantableProjectRoleWire)}
      >
        {GRANTABLE.map((r) => (
          <option key={r} value={r}>
            {roles[r]}
          </option>
        ))}
      </select>
      <button type="submit" className="btn pri" disabled={grant.isPending}>
        {m.grant}
      </button>
      {grant.isError && (
        <span className="field-error" role="alert">
          {messageOf(grant.error)}
        </span>
      )}
    </form>
  );
}
