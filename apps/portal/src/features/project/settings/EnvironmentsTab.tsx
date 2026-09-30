import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ENVIRONMENT } from "@udp/shared-types/environment-api";
import type { PublicEnvironmentWire } from "@udp/shared-types/wire";
import { useState } from "react";
import { ConfirmDialog } from "../../../components/ConfirmDialog";
import { InfoTip } from "../../../components/InfoTip";
import { toast } from "../../../components/Toast";
import { useMessages } from "../../../i18n";
import { fieldErrorsOf, messageOf } from "../../../lib/errors";
import { qk, qkPrefix } from "../../../lib/query-keys";
import { useProjectContext } from "../ProjectLayout";
import { projectApi } from "../project-api";
import { can } from "../roles";
import { settingsMessages } from "./settings.messages";

/**
 * [Plan #40] Environment của project (§9): thêm, bật tắt production và tự deploy, xoá.
 *
 * Danh sách đến từ ngữ cảnh project (`GET /projects/:id`) — cùng nguồn với bộ chọn env ở mọi
 * trang, nên thêm/xoá xong chỉ cần làm mới project. Project đang chạy trả kèm job dựng/dọn phần
 * cluster: báo người dùng xem tiến độ ở trang Hạ tầng. Xoá bị từ chối (còn flag bật, còn rollout,
 * đã có lịch sử) hiện ĐÚNG lý do server trả.
 */
export function EnvironmentsTab() {
  const t = useMessages(settingsMessages);
  const m = t.environments;
  const { project, envs } = useProjectContext();
  const queryClient = useQueryClient();
  const isOwner = can(project.myRole, "OWNER");
  const [name, setName] = useState("");
  const [isProduction, setIsProduction] = useState(false);
  const [removing, setRemoving] = useState<PublicEnvironmentWire | null>(null);
  /*
   * Bỏ đánh dấu Production gỡ mọi lớp bảo vệ của môi trường thật (xác nhận khi bật tắt flag, gõ
   * lại khi rollback, quyền MAINTAINER) — phải hỏi trước. Đánh dấu thêm thì chỉ chặt hơn, không hỏi.
   */
  const [demoting, setDemoting] = useState<PublicEnvironmentWire | null>(null);

  const refresh = async () => {
    await queryClient.invalidateQueries({ queryKey: qk.project(project.id) });
    await queryClient.invalidateQueries({
      queryKey: qkPrefix.flagsOf(project.id),
    });
    await queryClient.invalidateQueries({
      queryKey: qkPrefix.flagEnvsOf(project.id),
    });
    await queryClient.invalidateQueries({ queryKey: qk.jobs(project.id) });
  };
  const jobNotice = (job: { id: string } | null, done: string) => {
    toast.info(job === null ? done : m.applying(done));
  };

  const create = useMutation({
    // Idempotency-Key sinh LÚC BẤM GỬI (§9): khoá gắn với nội dung của lần gửi này
    mutationFn: () =>
      projectApi.createEnvironment(
        project.id,
        { name, isProduction },
        crypto.randomUUID(),
      ),
    onSuccess: async ({ environment, job }) => {
      setName("");
      setIsProduction(false);
      jobNotice(job, m.added(environment.name));
      await refresh();
    },
  });
  const update = useMutation({
    mutationFn: (v: {
      envId: string;
      body: { isProduction?: boolean; autoDeploy?: boolean };
    }) => projectApi.updateEnvironment(project.id, v.envId, v.body),
    onSuccess: async () => {
      setDemoting(null);
      await refresh();
    },
    onError: (e) => {
      setDemoting(null);
      toast.error(messageOf(e));
    },
  });
  const remove = useMutation({
    mutationFn: (envId: string) =>
      projectApi.deleteEnvironment(project.id, envId),
    onSuccess: async ({ job }) => {
      jobNotice(job, m.removed(removing?.name ?? ""));
      setRemoving(null);
      await refresh();
    },
  });
  const createErrors = fieldErrorsOf(create.error);
  const full = envs.length >= ENVIRONMENT.maxPerProject;

  return (
    <section aria-label={m.label}>
      {isOwner && (
        <form
          className="line"
          style={{ marginBottom: 14 }}
          onSubmit={(e) => {
            e.preventDefault();
            create.mutate();
          }}
        >
          <input
            className="inp mono"
            name="name"
            aria-label={m.newName}
            placeholder={m.newNamePlaceholder}
            autoComplete="off"
            spellCheck={false}
            maxLength={ENVIRONMENT.nameMaxLength}
            value={name}
            aria-invalid={createErrors.name !== undefined}
            aria-describedby={create.isError ? "env-add-err" : undefined}
            onChange={(e) => setName(e.target.value.toLowerCase())}
          />
          <label className="line check">
            <input
              type="checkbox"
              name="isProduction"
              checked={isProduction}
              onChange={(e) => setIsProduction(e.target.checked)}
            />
            {t.production}
          </label>
          <button
            type="submit"
            className="btn pri"
            disabled={name === "" || full || create.isPending}
          >
            {m.add}
          </button>
          {full && (
            <span className="c3">{m.full(ENVIRONMENT.maxPerProject)}</span>
          )}
          {create.isError && (
            <span id="env-add-err" className="field-error" role="alert">
              {createErrors.name ?? messageOf(create.error)}
            </span>
          )}
        </form>
      )}
      <p className="c3">
        {m.rules(ENVIRONMENT.nameMaxLength)}
        <InfoTip term="namespace" />
      </p>
      <div className="lst" role="list" aria-label={m.list}>
        {envs.map((e) => (
          <div key={e.id} className="it" role="listitem">
            <b className="mono lst-name" translate="no">
              {e.name}
            </b>
            <span className="c3 mono" translate="no">
              {e.k8sNamespace}
            </span>
            <label className="line check lst-end">
              <input
                type="checkbox"
                aria-label={m.isProduction(e.name)}
                checked={e.isProduction}
                disabled={!isOwner || update.isPending}
                onChange={(ev) => {
                  if (ev.target.checked) {
                    update.mutate({
                      envId: e.id,
                      body: { isProduction: true },
                    });
                  } else {
                    update.reset();
                    setDemoting(e);
                  }
                }}
              />
              {t.production}
            </label>
            <label className="line check">
              <input
                type="checkbox"
                aria-label={m.autoDeployOf(e.name)}
                checked={e.autoDeploy}
                disabled={!isOwner || update.isPending}
                onChange={(ev) =>
                  update.mutate({
                    envId: e.id,
                    body: { autoDeploy: ev.target.checked },
                  })
                }
              />
              {t.autoDeploy}
            </label>
            {isOwner && (
              <button
                type="button"
                className="btn danger"
                aria-label={m.deleteOf(e.name)}
                disabled={envs.length <= 1}
                onClick={() => {
                  remove.reset();
                  setRemoving(e);
                }}
              >
                {t.delete}
              </button>
            )}
          </div>
        ))}
      </div>

      {demoting !== null && (
        <ConfirmDialog
          title={m.demoteTitle(demoting.name)}
          description={m.demoteBody}
          confirmLabel={m.demote}
          danger
          typeToConfirm={demoting.name}
          busy={update.isPending}
          onConfirm={() =>
            update.mutate({
              envId: demoting.id,
              body: { isProduction: false },
            })
          }
          onClose={() => setDemoting(null)}
        />
      )}
      {removing !== null && (
        <ConfirmDialog
          title={m.deleteTitle(removing.name)}
          description={m.deleteBody}
          confirmLabel={m.deleteConfirm}
          danger
          typeToConfirm={removing.name}
          busy={remove.isPending}
          error={remove.isError ? messageOf(remove.error) : undefined}
          onConfirm={() => remove.mutate(removing.id)}
          onClose={() => setRemoving(null)}
        />
      )}
    </section>
  );
}
