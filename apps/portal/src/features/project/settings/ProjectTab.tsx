import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import type { ResourceQuotaWire } from "@udp/shared-types/wire";
import { useState } from "react";
import { ConfirmDialog } from "../../../components/ConfirmDialog";
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

  const num = (
    key: Exclude<keyof ResourceQuotaWire, "maxNodeSize">,
    label: string,
  ) => (
    <div className="f">
      <label htmlFor={`q-${key}`}>{label}</label>
      <input
        id={`q-${key}`}
        className="inp num"
        type="number"
        min={0}
        disabled={!isOwner}
        value={quota[key]}
        onChange={(e) => setQuota({ ...quota, [key]: Number(e.target.value) })}
      />
      {quotaErrors[`resourceQuota.${key}`] !== undefined && (
        <span className="field-error">
          {quotaErrors[`resourceQuota.${key}`]}
        </span>
      )}
    </div>
  );

  return (
    <section aria-label={m.label}>
      <dl className="props">
        <dt>{m.name}</dt>
        <dd>{project.name}</dd>
        <dt>{m.runtime}</dt>
        <dd className="mono">{project.languageRuntime}</dd>
        <dt>{m.createdAt}</dt>
        <dd>{formatDateTime(project.createdAt)}</dd>
      </dl>

      <h2 className="h2">{m.quota}</h2>
      <p className="c3">{m.quotaNote}</p>
      <div className="grid-f">
        {num("maxNodes", m.maxNodes)}
        <div className="f">
          <label htmlFor="q-size">{m.maxNodeSize}</label>
          <select
            id="q-size"
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
        </div>
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
        <p className="field-error">{messageOf(saveQuota.error)}</p>
      )}

      <h2 className="h2" style={{ marginTop: 22 }}>
        {m.ttl}
      </h2>
      <p className="c3">{m.ttlNote}</p>
      <div className="line">
        <input
          className="inp"
          type="date"
          aria-label={m.expiryDate}
          disabled={!isOwner}
          value={expires}
          onChange={(e) => setExpires(e.target.value)}
        />
        {isOwner && (
          <>
            <button
              type="button"
              className="btn"
              disabled={saveTtl.isPending}
              onClick={() => saveTtl.mutate()}
            >
              {m.saveTtl}
            </button>
            {expires !== "" && (
              <button
                type="button"
                className="btn"
                onClick={() => setExpires("")}
              >
                {m.clearTtl}
              </button>
            )}
          </>
        )}
      </div>
      {saveTtl.isError && (
        <p className="field-error">{messageOf(saveTtl.error)}</p>
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
