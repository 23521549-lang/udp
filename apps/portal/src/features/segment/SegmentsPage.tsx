import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import type { AttributeCondition } from "@udp/shared-types/condition";
import type {
  CreateSegmentFields,
  UpdateSegmentFields,
} from "@udp/shared-types/segment-api";
import type {
  SegmentDetailWire,
  SegmentListResponseWire,
} from "@udp/shared-types/wire";
import { Pencil, Plus, Trash2, X } from "lucide-react";
import { useState } from "react";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { Dialog } from "../../components/Dialog";
import { Icon } from "../../components/Icon";
import { Empty, ErrorState, Loading } from "../../components/States";
import { toast } from "../../components/Toast";
import { fieldErrorsOf, messageOf } from "../../lib/errors";
import {
  formatBytes,
  formatDateTime,
  formatNumber,
  formatPercent,
  relativeTime,
} from "../../lib/format";
import { qk } from "../../lib/query-keys";
import { AttributeConditions, TagInput } from "../flag/RuleEditor";
import { ProjectBar } from "../project/ProjectBar";
import { useProjectContext } from "../project/ProjectLayout";
import { can } from "../project/roles";
import { segmentApi } from "./segment-api";
import { quotaVerdict, segmentSizeOf } from "./segment-quota";
import { PageHead } from "../../components/PageHead";

/**
 * Segment (§2.2, v4.9): nhóm người dùng dùng lại ở nhiều rule. Thuộc PROJECT — một bản
 * cho mọi env — nên trang này không có bộ chọn môi trường và query key không có `envId`
 * (danh sách miễn trừ I38).
 *
 * Trần 4 MiB là của cả project, đo ở SQL; Portal chỉ biết tổng hiện tại từ `quota`, nên
 * cảnh báo trước khi lưu là cảnh báo gần đúng (sổ nợ `portal-segment-quota`).
 */
export function SegmentsPage() {
  const { project } = useProjectContext();
  const search = useSearch({ from: "/app/projects/$projectId/segments" });
  const navigate = useNavigate();
  const [editing, setEditing] = useState<SegmentDetailWire | "new" | null>(
    null,
  );

  const segments = useQuery({
    queryKey: qk.segments(project.id),
    queryFn: () => segmentApi.list(project.id),
  });

  const open = (segmentId: string | undefined) => {
    void navigate({
      to: ".",
      search: (prev: Record<string, unknown>) => {
        const { segment: _drop, ...rest } = prev;
        return segmentId === undefined ? rest : { ...rest, segment: segmentId };
      },
    });
  };

  const canWrite = can(project.myRole, "DEVELOPER");
  const quota = segments.data?.quota;

  return (
    <>
      <ProjectBar
        title="Segment"
        envScoped={false}
        actions={
          canWrite && (
            <button
              type="button"
              className="btn pri"
              onClick={() => setEditing("new")}
            >
              <Icon of={Plus} />
              Tạo segment
            </button>
          )
        }
      />
      <div className="body">
        <div className="scroll">
          <PageHead
            title="Segment"
            lead="Nhóm người dùng dùng chung cho rule ở mọi environment."
            {...(quota === undefined
              ? {}
              : {
                  minis: [
                    {
                      value: `${formatNumber(quota.segmentCount)}/${formatNumber(quota.maxSegments)}`,
                      label: "segment",
                    },
                    {
                      value: formatPercent(
                        Math.round(
                          (quota.payloadBytes / quota.maxPayloadBytes) * 100,
                        ),
                      ),
                      label: "dung lượng",
                    },
                  ],
                })}
          />
          <div className="page">
            {segments.isPending ? (
              <Loading />
            ) : segments.isError ? (
              <ErrorState
                error={segments.error}
                onRetry={() => void segments.refetch()}
              />
            ) : segments.data.segments.length === 0 ? (
              <Empty title="Chưa có segment nào" />
            ) : (
              <div className="lst" role="list" aria-label="Danh sách segment">
                {segments.data.segments.map((s) => (
                  <div role="listitem" key={s.id}>
                    {/* Link tới `?segment=<id>`: Ctrl-click mở đúng segment ở tab mới (Plan #53 QĐ-9) */}
                    <Link
                      to="."
                      search={(prev: Record<string, unknown>) => ({
                        ...prev,
                        segment: s.id,
                      })}
                      aria-current={
                        s.id === search.segment ? "true" : undefined
                      }
                    >
                      <b className="lst-name">{s.name}</b>
                      <span className="c3">
                        {s.summary.conditionCount} điều kiện,{" "}
                        {formatNumber(s.summary.userIdCount)} người dùng
                      </span>
                      <span className="c3 lst-end">
                        {s.usage.flagCount} flag dùng
                      </span>
                      <span className="c3" title={formatDateTime(s.updatedAt)}>
                        {relativeTime(s.updatedAt)}
                      </span>
                    </Link>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
        {search.segment !== undefined && (
          <SegmentPeek
            segmentId={search.segment}
            canWrite={canWrite}
            onEdit={(s) => setEditing(s)}
            onClose={() => open(undefined)}
          />
        )}
      </div>
      {editing !== null && (
        <SegmentDialog
          segment={editing === "new" ? undefined : editing}
          quota={quota}
          onClose={() => setEditing(null)}
          onSaved={(id) => {
            setEditing(null);
            open(id);
          }}
        />
      )}
    </>
  );
}

function SegmentPeek({
  segmentId,
  canWrite,
  onEdit,
  onClose,
}: {
  segmentId: string;
  canWrite: boolean;
  onEdit: (segment: SegmentDetailWire) => void;
  onClose: () => void;
}) {
  const { project } = useProjectContext();
  const queryClient = useQueryClient();
  const [deleting, setDeleting] = useState(false);
  const segment = useQuery({
    queryKey: qk.segment(project.id, segmentId),
    queryFn: () => segmentApi.get(project.id, segmentId),
  });
  const remove = useMutation({
    mutationFn: () => segmentApi.remove(project.id, segmentId),
    onSuccess: async () => {
      setDeleting(false);
      toast.info("Đã xoá segment");
      onClose();
      await queryClient.invalidateQueries({
        queryKey: qk.segments(project.id),
      });
    },
  });

  const s = segment.data?.segment;
  return (
    <aside className="peek" aria-label="Chi tiết segment">
      <div className="ph">
        <b>{s?.name ?? "…"}</b>
        <div
          className="r"
          style={{ marginLeft: "auto", display: "flex", gap: 6 }}
        >
          {canWrite && s !== undefined && (
            <>
              <button
                type="button"
                className="ib"
                aria-label="Sửa segment"
                onClick={() => onEdit(s)}
              >
                <Icon of={Pencil} />
              </button>
              <button
                type="button"
                className="ib"
                aria-label="Xoá segment"
                onClick={() => setDeleting(true)}
              >
                <Icon of={Trash2} />
              </button>
            </>
          )}
          <button
            type="button"
            className="ib"
            aria-label="Đóng"
            onClick={onClose}
          >
            <Icon of={X} />
          </button>
        </div>
      </div>
      <div className="inner">
        {segment.isPending ? (
          <Loading />
        ) : segment.isError ? (
          <ErrorState error={segment.error} />
        ) : s === undefined ? null : (
          <>
            <h2 className="title">{s.name}</h2>
            <p className="lead">{s.description ?? "Chưa có mô tả."}</p>
            <div className="sect">
              <h3>Khớp khi</h3>
            </div>
            {s.conditions.userIds.length > 0 && (
              <p>
                targetingKey thuộc{" "}
                <span className="mono">
                  {s.conditions.userIds.slice(0, 10).join(", ")}
                  {s.conditions.userIds.length > 10 ? ", …" : ""}
                </span>
              </p>
            )}
            {s.conditions.all.length > 0 && (
              <ul>
                {s.conditions.all.map((c, i) => (
                  <li key={i} className="mono">
                    {c.attribute} {c.operator} {JSON.stringify(c.value)}
                  </li>
                ))}
              </ul>
            )}
            <div className="sect">
              <h3>Flag đang dùng</h3>
            </div>
            {s.usage.flags.length === 0 ? (
              <p className="c3">Chưa rule nào dùng segment này.</p>
            ) : (
              <ul className="feed">
                {s.usage.flags.map((f) => (
                  <li key={f.flagId}>
                    <span />
                    <span className="mono">{f.flagKey}</span>
                    <span className="c3">
                      {f.envs.map((e) => e.name).join(", ")}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </div>
      {deleting && s !== undefined && (
        <ConfirmDialog
          title={`Xoá segment ${s.name}?`}
          description="Segment đang được rule dùng thì không xoá được."
          confirmLabel="Xoá"
          danger
          busy={remove.isPending}
          error={remove.isError ? messageOf(remove.error) : undefined}
          onConfirm={() => remove.mutate()}
          onClose={() => {
            setDeleting(false);
            remove.reset();
          }}
        />
      )}
    </aside>
  );
}

function SegmentDialog({
  segment,
  quota,
  onClose,
  onSaved,
}: {
  segment: SegmentDetailWire | undefined;
  quota: SegmentListResponseWire["quota"] | undefined;
  onClose: () => void;
  onSaved: (segmentId: string) => void;
}) {
  const { project } = useProjectContext();
  const queryClient = useQueryClient();
  const [name, setName] = useState(segment?.name ?? "");
  const [description, setDescription] = useState(segment?.description ?? "");
  const [all, setAll] = useState<AttributeCondition[]>(
    segment?.conditions.all ?? [],
  );
  const [userIds, setUserIds] = useState<string[]>(
    segment?.conditions.userIds ?? [],
  );

  const save = useMutation({
    mutationFn: () => {
      const conditions = { all, userIds };
      if (segment === undefined) {
        const body: CreateSegmentFields = {
          name: name.trim(),
          ...(description.trim() === ""
            ? {}
            : { description: description.trim() }),
          conditions,
        };
        return segmentApi.create(project.id, body);
      }
      const body: UpdateSegmentFields = {
        name: name.trim(),
        description: description.trim() === "" ? null : description.trim(),
        conditions,
        lastKnownUpdatedAt: segment.updatedAt,
      };
      return segmentApi.update(project.id, segment.id, body);
    },
    onSuccess: async ({ segment: saved }) => {
      toast.info("Đã lưu segment");
      await queryClient.invalidateQueries({
        queryKey: qk.segments(project.id),
      });
      await queryClient.invalidateQueries({
        queryKey: qk.segment(project.id, saved.id),
      });
      onSaved(saved.id);
    },
  });
  const fields = fieldErrorsOf(save.error);

  // Cảnh báo TRƯỚC khi gửi (sổ nợ `portal-segment-quota`); server vẫn là nơi quyết
  const size = segmentSizeOf({ all, userIds });
  const verdict =
    quota === undefined
      ? undefined
      : quotaVerdict({
          projectBytes: quota.payloadBytes,
          maxBytes: quota.maxPayloadBytes,
          editingBytes: segment?.summary.payloadBytes ?? 0,
          next: size,
        });
  const countFull =
    segment === undefined && quota !== undefined
      ? quota.segmentCount >= quota.maxSegments
      : false;

  return (
    <Dialog
      title={segment === undefined ? "Tạo segment" : `Sửa ${segment.name}`}
      description="Khớp khi targetingKey nằm trong danh sách, HOẶC mọi điều kiện thuộc tính đều đúng."
      onClose={onClose}
      wide
      footer={
        <>
          <button type="button" className="btn" data-close onClick={onClose}>
            Huỷ
          </button>
          <button
            type="button"
            className="btn pri"
            disabled={
              name.trim() === "" ||
              (all.length === 0 && userIds.length === 0) ||
              save.isPending
            }
            onClick={() => save.mutate()}
          >
            {save.isPending ? "Đang lưu…" : "Lưu"}
          </button>
        </>
      }
    >
      <div className="f">
        <label htmlFor="seg-name">Tên</label>
        <input
          id="seg-name"
          className="inp"
          value={name}
          aria-invalid={fields.name !== undefined}
          onChange={(e) => setName(e.target.value)}
        />
        {fields.name !== undefined && (
          <span className="field-error">{fields.name}</span>
        )}
      </div>
      <div className="f">
        <label htmlFor="seg-desc">Mô tả</label>
        <input
          id="seg-desc"
          className="inp"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
        />
      </div>
      <div className="f">
        <span className="lbl">targetingKey thuộc</span>
        <TagInput
          label="Danh sách targetingKey"
          values={userIds}
          readOnly={false}
          onChange={setUserIds}
        />
      </div>
      <div className="f">
        <span className="lbl">Hoặc mọi điều kiện sau đều đúng</span>
        <AttributeConditions
          label="segment"
          value={all}
          readOnly={false}
          onChange={setAll}
        />
      </div>
      {quota !== undefined && verdict !== undefined && (
        <p
          className={verdict.verdict === "ok" ? "help" : "field-error"}
          role={verdict.verdict === "ok" ? undefined : "alert"}
        >
          {verdict.verdict === "over"
            ? `Vượt trần dung lượng của project: sau khi lưu ít nhất ${formatBytes(verdict.projectedLower)} trên ${formatBytes(quota.maxPayloadBytes)}. Máy chủ sẽ từ chối.`
            : verdict.verdict === "maybe"
              ? `Sát trần dung lượng của project (khoảng ${formatBytes(verdict.projectedLower)} trên ${formatBytes(quota.maxPayloadBytes)}); có thể bị từ chối.`
              : `Dung lượng sau khi lưu: khoảng ${formatBytes(verdict.projectedLower)} trên ${formatBytes(quota.maxPayloadBytes)}.`}
        </p>
      )}
      {countFull && (
        <p className="field-error" role="alert">
          Project đã có {quota?.segmentCount}/{quota?.maxSegments} segment: tạo
          thêm sẽ bị từ chối.
        </p>
      )}
      {save.isError && (
        <p role="alert" className="field-error">
          {Object.values(fields)[0] ?? messageOf(save.error)}
        </p>
      )}
    </Dialog>
  );
}
