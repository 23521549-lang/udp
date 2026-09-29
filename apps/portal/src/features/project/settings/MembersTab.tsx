import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ProjectRoleWire } from "@udp/shared-types/wire";
import { useState } from "react";
import { ConfirmDialog } from "../../../components/ConfirmDialog";
import { ErrorState, Loading } from "../../../components/States";
import { toast } from "../../../components/Toast";
import { fieldErrorsOf, messageOf } from "../../../lib/errors";
import { qk, qkPrefix } from "../../../lib/query-keys";
import { useProjectContext } from "../ProjectLayout";
import { projectApi } from "../project-api";
import { useMessages } from "../../../i18n";
import { can, PERMISSIONS } from "../roles";
import { rolesMessages } from "../roles.messages";
import { settingsMessages } from "./settings.messages";

const ASSIGNABLE: Exclude<ProjectRoleWire, "OWNER">[] = [
  "MAINTAINER",
  "DEVELOPER",
  "VIEWER",
];

export function MembersTab() {
  const { role: roles, permission } = useMessages(rolesMessages);
  const m = useMessages(settingsMessages).members;
  const { project } = useProjectContext();
  const queryClient = useQueryClient();
  const [email, setEmail] = useState("");
  const [role, setRole] =
    useState<Exclude<ProjectRoleWire, "OWNER">>("DEVELOPER");
  const [transferTo, setTransferTo] = useState<{
    id: string;
    email: string;
  } | null>(null);
  const members = useQuery({
    queryKey: qk.members(project.id),
    queryFn: () => projectApi.members(project.id),
  });
  const refresh = async () => {
    await queryClient.invalidateQueries({ queryKey: qk.members(project.id) });
  };

  const add = useMutation({
    // Idempotency-Key sinh LÚC BẤM GỬI (§9): khoá gắn với nội dung của lần gửi này
    mutationFn: () =>
      projectApi.addMember(
        project.id,
        { email, projectRole: role },
        crypto.randomUUID(),
      ),
    onSuccess: async () => {
      setEmail("");
      toast.info(m.added);
      await refresh();
    },
  });
  /*
   * Đổi vai và xoá thành viên tác động NGAY, nhưng có Hoàn tác 5 giây (DESIGN.md §7 "hoàn tác thay vì
   * hỏi lại"): hoàn tác đổi vai là đổi về vai cũ, hoàn tác xoá là mời lại đúng email với đúng vai cũ.
   */
  type Assignable = Exclude<ProjectRoleWire, "OWNER">;
  const update = useMutation({
    mutationFn: (v: { userId: string; role: Assignable }) =>
      projectApi.updateMember(project.id, v.userId, v.role),
    onSuccess: refresh,
    onError: (e) => toast.error(messageOf(e)),
  });
  const changeRole = (
    member: { userId: string; email: string; role: Assignable },
    next: Assignable,
  ): void => {
    update.mutate(
      { userId: member.userId, role: next },
      {
        onSuccess: () =>
          toast.info(m.roleChanged(member.email, roles[next]), () =>
            update.mutate({ userId: member.userId, role: member.role }),
          ),
      },
    );
  };
  const reinvite = useMutation({
    mutationFn: (v: { email: string; role: Assignable }) =>
      projectApi.addMember(
        project.id,
        { email: v.email, projectRole: v.role },
        crypto.randomUUID(),
      ),
    onSuccess: refresh,
    onError: (e) => toast.error(messageOf(e)),
  });
  const remove = useMutation({
    mutationFn: (member: { userId: string; email: string; role: Assignable }) =>
      projectApi.removeMember(project.id, member.userId),
    onSuccess: async (_d, member) => {
      toast.info(m.removed(member.email), () =>
        reinvite.mutate({ email: member.email, role: member.role }),
      );
      await refresh();
    },
    onError: (e) => toast.error(messageOf(e)),
  });
  const transfer = useMutation({
    mutationFn: (userId: string) =>
      projectApi.transferOwnership(project.id, userId),
    onSuccess: async () => {
      setTransferTo(null);
      toast.info(m.transferred);
      await refresh();
      await queryClient.invalidateQueries({ queryKey: qk.project(project.id) });
      await queryClient.invalidateQueries({ queryKey: qkPrefix.projectsAll() });
    },
  });
  const isOwner = can(project.myRole, "OWNER");
  const addErrors = fieldErrorsOf(add.error);

  return (
    <section aria-label={m.label}>
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
            aria-describedby={add.isError ? "member-add-err" : undefined}
            placeholder={m.newEmailPlaceholder}
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
          <select
            className="sel"
            aria-label={m.newRole}
            value={role}
            onChange={(e) => setRole(e.target.value as typeof role)}
          >
            {ASSIGNABLE.map((r) => (
              <option key={r} value={r}>
                {roles[r]}
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
            <span id="member-add-err" className="field-error" role="alert">
              {addErrors.email ?? messageOf(add.error)}
            </span>
          )}
        </form>
      )}
      {members.isPending ? (
        <Loading />
      ) : members.isError ? (
        <ErrorState
          error={members.error}
          onRetry={() => void members.refetch()}
        />
      ) : (
        <div className="lst" role="list" aria-label={m.list}>
          {members.data.members.map((x) => (
            <div key={x.userId} className="it" role="listitem">
              <b className="lst-name">{x.user.name}</b>
              <span className="c3" translate="no">
                {x.user.email}
              </span>
              <span className="lst-end">
                {isOwner && x.projectRole !== "OWNER" ? (
                  <select
                    className="sel"
                    aria-label={m.roleOf(x.user.email)}
                    value={x.projectRole}
                    disabled={update.isPending}
                    onChange={(e) =>
                      changeRole(
                        {
                          userId: x.userId,
                          email: x.user.email,
                          role: x.projectRole as Assignable,
                        },
                        e.target.value as Assignable,
                      )
                    }
                  >
                    {ASSIGNABLE.map((r) => (
                      <option key={r} value={r}>
                        {roles[r]}
                      </option>
                    ))}
                  </select>
                ) : (
                  roles[x.projectRole]
                )}
              </span>
              {isOwner && x.projectRole !== "OWNER" && (
                <>
                  <button
                    type="button"
                    className="btn"
                    aria-label={m.transferTo(x.user.email)}
                    onClick={() =>
                      setTransferTo({ id: x.userId, email: x.user.email })
                    }
                  >
                    {m.transfer}
                  </button>
                  <button
                    type="button"
                    className="btn danger"
                    aria-label={m.removeOf(x.user.email)}
                    disabled={remove.isPending}
                    onClick={() =>
                      remove.mutate({
                        userId: x.userId,
                        email: x.user.email,
                        role: x.projectRole as Assignable,
                      })
                    }
                  >
                    {m.remove}
                  </button>
                </>
              )}
            </div>
          ))}
        </div>
      )}

      <h2 className="h2">{m.matrix}</h2>
      <div className="table-wrap">
        <table className="matrix">
          <thead>
            <tr>
              <th scope="col">{m.action}</th>
              {(["VIEWER", "DEVELOPER", "MAINTAINER", "OWNER"] as const).map(
                (r) => (
                  <th key={r} scope="col">
                    {roles[r]}
                  </th>
                ),
              )}
            </tr>
          </thead>
          <tbody>
            {PERMISSIONS.map((p) => (
              <tr key={p.key}>
                <th scope="row">{permission[p.key]}</th>
                {(["VIEWER", "DEVELOPER", "MAINTAINER", "OWNER"] as const).map(
                  (r) => (
                    <td key={r}>{can(r, p.min) ? m.yes : "–"}</td>
                  ),
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {transferTo !== null && (
        <ConfirmDialog
          title={m.transferTitle}
          description={m.transferBody(transferTo.email)}
          confirmLabel={m.transferConfirm}
          danger
          typeToConfirm={transferTo.email}
          busy={transfer.isPending}
          error={transfer.isError ? messageOf(transfer.error) : undefined}
          onConfirm={() => transfer.mutate(transferTo.id)}
          onClose={() => {
            setTransferTo(null);
            transfer.reset();
          }}
        />
      )}
    </section>
  );
}
