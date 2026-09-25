import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import type { ResourceQuotaWire } from "@udp/shared-types/wire";
import { useState } from "react";
import { ConfirmDialog } from "../../../components/ConfirmDialog";
import { toast } from "../../../components/Toast";
import { fieldErrorsOf, messageOf } from "../../../lib/errors";
import { formatDateTime } from "../../../lib/format";
import { qk } from "../../../lib/query-keys";
import { useProjectContext } from "../ProjectLayout";
import { projectApi } from "../project-api";
import { can } from "../roles";

const NODE_SIZES = ["small", "medium", "large"] as const;

export function ProjectTab() {
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
    await queryClient.invalidateQueries({ queryKey: qk.projects() });
  };
  const saveQuota = useMutation({
    mutationFn: () => projectApi.updateQuota(project.id, quota),
    onSuccess: async () => {
      toast.info("Đã lưu trần tài nguyên");
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
      toast.info("Đã lưu hạn dùng");
      await refresh();
    },
  });
  const remove = useMutation({
    mutationFn: () => projectApi.remove(project.id),
    onSuccess: async () => {
      queryClient.removeQueries({ queryKey: qk.project(project.id) });
      await queryClient.invalidateQueries({ queryKey: qk.projects() });
      toast.info("Đã xoá project");
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
    <section aria-label="Project">
      <dl className="props">
        <dt>Tên</dt>
        <dd>{project.name}</dd>
        <dt>Runtime</dt>
        <dd className="mono">{project.languageRuntime}</dd>
        <dt>Tạo lúc</dt>
        <dd>{formatDateTime(project.createdAt)}</dd>
      </dl>

      <h3 className="h2">Trần tài nguyên</h3>
      <p className="c3">
        Cưỡng chế chứ không phải gợi ý: provisioning vượt trần bị từ chối
        (§4.4).
      </p>
      <div className="grid-f">
        {num("maxNodes", "Số node tối đa")}
        <div className="f">
          <label htmlFor="q-size">Cỡ node tối đa</label>
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
        {num("maxDatabases", "Số database tối đa")}
        {num("maxStorageGb", "Dung lượng tối đa (GB)")}
        {num("maxLoadBalancers", "Số load balancer tối đa")}
      </div>
      {isOwner && (
        <button
          type="button"
          className="btn pri"
          disabled={saveQuota.isPending}
          onClick={() => saveQuota.mutate()}
        >
          Lưu trần
        </button>
      )}
      {saveQuota.isError && Object.keys(quotaErrors).length === 0 && (
        <p className="field-error">{messageOf(saveQuota.error)}</p>
      )}

      <h3 className="h2" style={{ marginTop: 22 }}>
        Hạn dùng
      </h3>
      <p className="c3">
        Hết hạn thì chỉ cảnh báo chủ sở hữu, không tự xoá tài nguyên của bạn
        (§4.4).
      </p>
      <div className="line">
        <input
          className="inp"
          type="date"
          aria-label="Ngày hết hạn"
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
              Lưu hạn
            </button>
            {expires !== "" && (
              <button
                type="button"
                className="btn"
                onClick={() => setExpires("")}
              >
                Bỏ hạn
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
          <h3 className="h2" style={{ marginTop: 22 }}>
            Vùng nguy hiểm
          </h3>
          <button
            type="button"
            className="btn danger"
            onClick={() => setDeleting(true)}
          >
            Xoá project
          </button>
        </>
      )}
      {deleting && (
        <ConfirmDialog
          title={`Xoá ${project.name}?`}
          description="Project bị xoá mềm: nhật ký kiểm toán được giữ. Tài nguyên cloud chưa được tự dọn."
          confirmLabel="Xoá project"
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
