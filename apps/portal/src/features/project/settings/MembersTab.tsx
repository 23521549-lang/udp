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
import { can, PERMISSIONS, ROLE_LABEL } from "../roles";

const ASSIGNABLE: Exclude<ProjectRoleWire, "OWNER">[] = [
  "MAINTAINER",
  "DEVELOPER",
  "VIEWER",
];

export function MembersTab() {
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
      toast.info("Đã thêm thành viên");
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
    m: { userId: string; email: string; role: Assignable },
    next: Assignable,
  ): void => {
    update.mutate(
      { userId: m.userId, role: next },
      {
        onSuccess: () =>
          toast.info(`Đã đổi vai ${m.email} thành ${ROLE_LABEL[next]}`, () =>
            update.mutate({ userId: m.userId, role: m.role }),
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
    mutationFn: (m: { userId: string; email: string; role: Assignable }) =>
      projectApi.removeMember(project.id, m.userId),
    onSuccess: async (_d, m) => {
      toast.info(`Đã xoá ${m.email} khỏi project`, () =>
        reinvite.mutate({ email: m.email, role: m.role }),
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
      toast.info("Đã chuyển quyền sở hữu");
      await refresh();
      await queryClient.invalidateQueries({ queryKey: qk.project(project.id) });
      await queryClient.invalidateQueries({ queryKey: qkPrefix.projectsAll() });
    },
  });
  const isOwner = can(project.myRole, "OWNER");
  const addErrors = fieldErrorsOf(add.error);

  return (
    <section aria-label="Thành viên">
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
            aria-label="Email thành viên mới"
            aria-invalid={addErrors.email !== undefined}
            aria-describedby={add.isError ? "member-add-err" : undefined}
            placeholder="email@congty.vn…"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
          <select
            className="sel"
            aria-label="Vai của thành viên mới"
            value={role}
            onChange={(e) => setRole(e.target.value as typeof role)}
          >
            {ASSIGNABLE.map((r) => (
              <option key={r} value={r}>
                {ROLE_LABEL[r]}
              </option>
            ))}
          </select>
          <button
            type="submit"
            className="btn pri"
            disabled={email === "" || add.isPending}
          >
            Mời
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
        <div className="lst" role="list" aria-label="Thành viên của project">
          {members.data.members.map((m) => (
            <div key={m.userId} className="it" role="listitem">
              <b className="lst-name">{m.user.name}</b>
              <span className="c3" translate="no">
                {m.user.email}
              </span>
              <span className="lst-end">
                {isOwner && m.projectRole !== "OWNER" ? (
                  <select
                    className="sel"
                    aria-label={`Vai của ${m.user.email}`}
                    value={m.projectRole}
                    disabled={update.isPending}
                    onChange={(e) =>
                      changeRole(
                        {
                          userId: m.userId,
                          email: m.user.email,
                          role: m.projectRole as Assignable,
                        },
                        e.target.value as Assignable,
                      )
                    }
                  >
                    {ASSIGNABLE.map((r) => (
                      <option key={r} value={r}>
                        {ROLE_LABEL[r]}
                      </option>
                    ))}
                  </select>
                ) : (
                  ROLE_LABEL[m.projectRole]
                )}
              </span>
              {isOwner && m.projectRole !== "OWNER" && (
                <>
                  <button
                    type="button"
                    className="btn"
                    aria-label={`Chuyển quyền chủ cho ${m.user.email}`}
                    onClick={() =>
                      setTransferTo({ id: m.userId, email: m.user.email })
                    }
                  >
                    Chuyển chủ
                  </button>
                  <button
                    type="button"
                    className="btn danger"
                    aria-label={`Xoá ${m.user.email} khỏi project`}
                    disabled={remove.isPending}
                    onClick={() =>
                      remove.mutate({
                        userId: m.userId,
                        email: m.user.email,
                        role: m.projectRole as Assignable,
                      })
                    }
                  >
                    Xoá
                  </button>
                </>
              )}
            </div>
          ))}
        </div>
      )}

      <h2 className="h2">Mỗi vai làm được gì</h2>
      <div className="table-wrap">
        <table className="matrix">
          <thead>
            <tr>
              <th scope="col">Việc</th>
              {(["VIEWER", "DEVELOPER", "MAINTAINER", "OWNER"] as const).map(
                (r) => (
                  <th key={r} scope="col">
                    {ROLE_LABEL[r]}
                  </th>
                ),
              )}
            </tr>
          </thead>
          <tbody>
            {PERMISSIONS.map((p) => (
              <tr key={p.action}>
                <th scope="row">{p.action}</th>
                {(["VIEWER", "DEVELOPER", "MAINTAINER", "OWNER"] as const).map(
                  (r) => (
                    <td key={r}>{can(r, p.min) ? "Có" : "–"}</td>
                  ),
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {transferTo !== null && (
        <ConfirmDialog
          title="Chuyển quyền sở hữu?"
          description={`${transferTo.email} thành chủ sở hữu; bạn trở thành Người duy trì. Không tự hoàn tác được.`}
          confirmLabel="Chuyển"
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
