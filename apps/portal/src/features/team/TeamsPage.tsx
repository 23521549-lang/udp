import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { PageHead } from "../../components/PageHead";
import { Empty, ErrorState, Loading } from "../../components/States";
import { toast } from "../../components/Toast";
import { useMessages } from "../../i18n";
import { fieldErrorsOf, messageOf } from "../../lib/errors";
import { qk } from "../../lib/query-keys";
import { teamApi } from "./team-api";
import { teamMessages } from "./team.messages";

/** [Plan #55 QĐ-5] `/app/teams` — nhóm của người đăng nhập, và tạo nhóm mới */
export function TeamsPage() {
  const t = useMessages(teamMessages);
  const m = t.list;
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [name, setName] = useState("");
  const teams = useQuery({ queryKey: qk.teams(), queryFn: teamApi.list });

  const create = useMutation({
    mutationFn: () => teamApi.create(name.trim()),
    onSuccess: async ({ team }) => {
      setName("");
      toast.info(m.created(team.name));
      await queryClient.invalidateQueries({ queryKey: qk.teams() });
      await navigate({
        to: "/app/teams/$teamId",
        params: { teamId: team.id },
      });
    },
  });
  const errors = fieldErrorsOf(create.error);

  return (
    <>
      <div className="bar">
        <div className="crumbs">
          <b>{m.title}</b>
        </div>
      </div>
      <div className="scroll">
        <PageHead title={m.title} lead={m.lead} />
        <div className="page">
          <form
            className="line"
            style={{ marginBottom: 14 }}
            onSubmit={(e) => {
              e.preventDefault();
              create.mutate();
            }}
          >
            <input
              className="inp"
              name="name"
              autoComplete="off"
              maxLength={80}
              aria-label={m.newName}
              aria-invalid={errors.name !== undefined}
              aria-describedby={create.isError ? "team-create-err" : undefined}
              placeholder={m.newNamePlaceholder}
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
            <button
              type="submit"
              className="btn pri"
              disabled={name.trim() === "" || create.isPending}
            >
              {m.create}
            </button>
            {create.isError && (
              <span id="team-create-err" className="field-error" role="alert">
                {errors.name ?? messageOf(create.error)}
              </span>
            )}
          </form>
          {teams.isPending ? (
            <Loading />
          ) : teams.isError ? (
            <ErrorState
              error={teams.error}
              onRetry={() => void teams.refetch()}
            />
          ) : teams.data.teams.length === 0 ? (
            <Empty title={m.empty}>{m.emptyHint}</Empty>
          ) : (
            <div className="lst" role="list" aria-label={m.label}>
              {teams.data.teams.map((team) => (
                <div role="listitem" key={team.id}>
                  <Link to="/app/teams/$teamId" params={{ teamId: team.id }}>
                    <span className="t lst-name" translate="no">
                      {team.name}
                    </span>
                    <span className="chip soft">{t.role[team.myRole]}</span>
                    <span className="lst-end c3">
                      {m.members(team.memberCount)}
                    </span>
                    <span className="c3">{m.projects(team.projectCount)}</span>
                  </Link>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </>
  );
}
