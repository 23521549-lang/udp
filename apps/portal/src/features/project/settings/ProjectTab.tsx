import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import type { ResourceQuotaWire } from "@udp/shared-types/wire";
import { useRef, useState } from "react";
import { ConfirmDialog } from "../../../components/ConfirmDialog";
import { Field, focusFirstInvalid } from "../../../components/Field";
import { toast } from "../../../components/Toast";
import { useMessages } from "../../../i18n";
import { fieldErrorsOf, messageOf } from "../../../lib/errors";
import { formatDateTime } from "../../../lib/format";
import { qk, qkPrefix } from "../../../lib/query-keys";
import { useProjectContext } from "../ProjectLayout";
import { projectApi } from "../project-api";
import { can } from "../roles";
import { settingsMessages } from "./settings.messages";

const NODE_SIZES = ["small", "medium", "large"] as const;

export function ProjectTab() {
  const m = useMessages(settingsMessages).project;
  const { project } = useProjectContext();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const isOwner = can(project.myRole, "OWNER");
  const q = project.resourceQuota;
  const [quota, setQuota] = useState<Required<ResourceQuotaWire>>({
    maxNodes: q.maxNodes ?? 3,
    maxNodeSize: q.maxNodeSize ?? "small",
    maxDatabases: q.maxDatabases ?? 1,
    maxStorageGb: q.maxStorageGb ?? 20,
    maxLoadBalancers: q.maxLoadBalancers ?? 1,
  });
  const [expires, setExpires] = useState(
    project.expiresAt === null ? "" : project.expiresAt.slice(0, 10),
  );
  const [deleting, setDeleting] = useState(false);
  const [ttlPast, setTtlPast] = useState(false);
  const quotaRef = useRef<HTMLDivElement>(null);
  const ttlRef = useRef<HTMLDivElement>(null);

  const refresh = async () => {
    await queryClient.invalidateQueries({ queryKey: qk.project(project.id) });
    await queryClient.invalidateQueries({ queryKey: qkPrefix.projectsAll() });
  };
  const saveQuota = useMutation({
    mutationFn: () => projectApi.updateQuota(project.id, quota),
    onSuccess: async () => {
      toast.info(m.quotaSaved);
      await refresh();
    },
    // [Plan #58 UX-39] Lỗi nằm dưới đúng ô; con trỏ tới ô sai đầu tiên
    onError: () =>
      requestAnimationFrame(() => focusFirstInvalid(quotaRef.current)),
  });
  const saveTtl = useMutation({
    // Ngày theo giờ ĐỊA PHƯƠNG, gửi ISO có offset (§ updateTtlSchema): cuối ngày đã chọn
    mutationFn: () =>
      projectApi.updateTtl(
        project.id,
        expires === "" ? null : new Date(`${expires}T23:59:59`).toISOString(),
      ),
    onSuccess: async () => {
      toast.info(m.ttlSaved);
      await refresh();
    },
    onError: () =>
      requestAnimationFrame(() => focusFirstInvalid(ttlRef.current)),
  });
  const remove = useMutation({
    mutationFn: () => projectApi.remove(project.id),
    onSuccess: async () => {
      queryClient.removeQueries({ queryKey: qk.project(project.id) });
      await queryClient.invalidateQueries({ queryKey: qkPrefix.projectsAll() });
      toast.info(m.deleted);
      await navigate({ to: "/app/projects" });
    },
  });
  const quotaErrors = fieldErrorsOf(saveQuota.error);
  const ttlErrors = fieldErrorsOf(saveTtl.error);
  /** Ngày đã qua thì báo ngay, kèm cách sửa, không gửi đi để nghe máy chủ từ chối */
  const submitTtl = (): void => {
    const past =
      expires !== "" && new Date(`${expires}T23:59:59`).getTime() <= Date.now();
    setTtlPast(past);
    if (past) requestAnimationFrame(() => focusFirstInvalid(ttlRef.current));
    else saveTtl.mutate();
  };

  const num = (
    key: Exclude<keyof ResourceQuotaWire, "maxNodeSize">,
    label: string,
  ) => (
    <Field
      id={`q-${key}`}
      label={label}
      error={quotaErrors[`resourceQuota.${key}`]}
    >
      {(p) => (
        <input
          {...p}
          className="inp num"
          type="number"
          inputMode="numeric"
          min={0}
          disabled={!isOwner}
          value={quota[key]}
          onChange={(e) =>
            setQuota({ ...quota, [key]: Number(e.target.value) })
          }
        />
      )}
    </Field>
  );

  return (
    <section aria-label={m.label}>
      <dl className="props">
        <dt>{m.name}</dt>
        <dd translate="no">{project.name}</dd>
        <dt>{m.runtime}</dt>
        <dd className="mono">{project.languageRuntime}</dd>
        <dt>{m.createdAt}</dt>
        <dd>{formatDateTime(project.createdAt)}</dd>
      </dl>

      <h2 className="h2">{m.quota}</h2>
      <p className="c3">{m.quotaNote}</p>
      <div className="grid-f" ref={quotaRef}>
        {num("maxNodes", m.maxNodes)}
        <Field
          id="q-size"
          label={m.maxNodeSize}
          error={quotaErrors["resourceQuota.maxNodeSize"]}
        >
          {(p) => (
            <select
              {...p}
              className="sel"
              disabled={!isOwner}
              value={quota.maxNodeSize}
              onChange={(e) =>
                setQuota({ ...quota, maxNodeSize: e.target.value })
              }
            >
              {NODE_SIZES.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          )}
        </Field>
        {num("maxDatabases", m.maxDatabases)}
        {num("maxStorageGb", m.maxStorageGb)}
        {num("maxLoadBalancers", m.maxLoadBalancers)}
      </div>
      {isOwner && (
        <button
          type="button"
          className="btn pri"
          disabled={saveQuota.isPending}
          onClick={() => saveQuota.mutate()}
        >
          {m.saveQuota}
        </button>
      )}
      {saveQuota.isError && Object.keys(quotaErrors).length === 0 && (
        <p role="alert" className="field-error">
          {messageOf(saveQuota.error)}
        </p>
      )}

      <h2 className="h2" style={{ marginTop: 22 }}>
        {m.ttl}
      </h2>
      <p className="c3">{m.ttlNote}</p>
      <div className="line ttl-line" ref={ttlRef}>
        <Field
          id="p-ttl"
          label={m.expiryDate}
          error={ttlPast ? m.ttlPast : ttlErrors.expiresAt}
        >
          {(p) => (
            <input
              {...p}
              className="inp"
              type="date"
              disabled={!isOwner}
              value={expires}
              onChange={(e) => setExpires(e.target.value)}
            />
          )}
        </Field>
        {isOwner && (
          <>
            <button
              type="button"
              className="btn"
              disabled={saveTtl.isPending}
              onClick={submitTtl}
            >
              {m.saveTtl}
            </button>
            {expires !== "" && (
              <button
                type="button"
                className="btn"
                onClick={() => {
                  setExpires("");
                  setTtlPast(false);
                }}
              >
                {m.clearTtl}
              </button>
            )}
          </>
        )}
      </div>
      {saveTtl.isError && ttlErrors.expiresAt === undefined && (
        <p role="alert" className="field-error">
          {messageOf(saveTtl.error)}
        </p>
      )}

      {isOwner && (
        <>
          <h2 className="h2" style={{ marginTop: 22 }}>
            {m.danger}
          </h2>
          <button
            type="button"
            className="btn danger"
            onClick={() => setDeleting(true)}
          >
            {m.deleteProject}
          </button>
        </>
      )}
      {deleting && (
        <ConfirmDialog
          title={m.deleteTitle(project.name)}
          description={m.deleteBody}
          confirmLabel={m.deleteProject}
          danger
          typeToConfirm={project.name}
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
