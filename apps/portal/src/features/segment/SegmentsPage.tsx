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
import { useEffect, useRef, useState, type RefObject } from "react";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { Dialog } from "../../components/Dialog";
import { Field, focusFirstInvalid } from "../../components/Field";
import { Icon } from "../../components/Icon";
import { InfoTip } from "../../components/InfoTip";
import { Empty, ErrorState, Loading } from "../../components/States";
import { toast } from "../../components/Toast";
import { useMessages } from "../../i18n";
import { fieldErrorsOf, messageOf } from "../../lib/errors";
import {
  formatBytes,
  formatDateTime,
  formatNumber,
  formatPercent,
  relativeTime,
} from "../../lib/format";
import { qk } from "../../lib/query-keys";
import { usePeekFocus } from "../../lib/use-peek-focus";
import { AttributeConditions, TagInput } from "../flag/RuleEditor";
import { ProjectBar } from "../project/ProjectBar";
import { useProjectContext } from "../project/ProjectLayout";
import { can } from "../project/roles";
import { rolesMessages } from "../project/roles.messages";
import { segmentApi } from "./segment-api";
import { quotaVerdict, segmentSizeOf } from "./segment-quota";
import { segmentMessages } from "./segment.messages";
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
  const m = useMessages(segmentMessages);
  const roles = useMessages(rolesMessages);
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

  /*
   * [Plan #58 UX-38] Panel segment: focus vào panel khi mở, Esc đóng, đóng xong focus về dòng đã mở. Hook nằm ở
   * trang vì panel bị gỡ khi đóng. Esc trong hộp thoại (sửa, xoá) chỉ đóng hộp thoại đó.
   */
  const panel = useRef<HTMLElement>(null);
  usePeekFocus(panel, search.segment, () => {
    if (document.querySelector("[role=dialog]") === null) open(undefined);
  });

  return (
    <>
      <ProjectBar
        title={m.title}
        envScoped={false}
        actions={
          canWrite && (
            <button
              type="button"
              className="btn pri"
              onClick={() => setEditing("new")}
            >
              <Icon of={Plus} />
              {m.create}
            </button>
          )
        }
      />
      <div className="body">
        <div className="scroll">
          <PageHead
            title={m.title}
            lead={
              <>
                {m.lead}
                <InfoTip term="segment" />
              </>
            }
            {...(quota === undefined
              ? {}
              : {
                  minis: [
                    {
                      value: `${formatNumber(quota.segmentCount)}/${formatNumber(quota.maxSegments)}`,
                      label: m.miniSegments,
                    },
                    {
                      value: formatPercent(
                        Math.round(
                          (quota.payloadBytes / quota.maxPayloadBytes) * 100,
                        ),
                      ),
                      label: m.miniStorage,
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
              // [Plan #58 UX-17] Vì sao trống, cần gì trước, và một nút
              <Empty title={m.empty}>
                <div className="empty-body">
                  <p>{m.emptyWhy}</p>
                  <p>{m.emptyNeed}</p>
                  {canWrite ? (
                    <button
                      type="button"
                      className="btn pri"
                      onClick={() => setEditing("new")}
                    >
                      {m.createFirst}
                    </button>
                  ) : (
                    <p>{m.emptyRole(roles.role.DEVELOPER)}</p>
                  )}
                </div>
              </Empty>
            ) : (
              <div className="lst" role="list" aria-label={m.list}>
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
                      <b className="lst-name" translate="no">
                        {s.name}
                      </b>
                      <span className="c3">
                        {m.summary(
                          s.summary.conditionCount,
                          s.summary.userIdCount,
                        )}
                      </span>
                      <span className="c3 lst-end">
                        {m.usedBy(s.usage.flagCount)}
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
            panelRef={panel}
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
  panelRef,
  canWrite,
  onEdit,
  onClose,
}: {
  segmentId: string;
  panelRef: RefObject<HTMLElement>;
  canWrite: boolean;
  onEdit: (segment: SegmentDetailWire) => void;
  onClose: () => void;
}) {
  const m = useMessages(segmentMessages);
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
      toast.info(m.deleted);
      onClose();
      await queryClient.invalidateQueries({
        queryKey: qk.segments(project.id),
      });
    },
  });

  const s = segment.data?.segment;
  return (
    <aside ref={panelRef} className="peek" aria-label={m.details} tabIndex={-1}>
      <div className="ph">
        <b translate="no">{s?.name ?? "…"}</b>
        <div
          className="r"
          style={{ marginLeft: "auto", display: "flex", gap: 6 }}
        >
          {canWrite && s !== undefined && (
            <>
              <button
                type="button"
                className="ib"
                aria-label={m.edit}
                onClick={() => onEdit(s)}
              >
                <Icon of={Pencil} />
              </button>
              <button
                type="button"
                className="ib"
                aria-label={m.delete}
                onClick={() => setDeleting(true)}
              >
                <Icon of={Trash2} />
              </button>
            </>
          )}
          <button
            type="button"
            className="ib"
            aria-label={m.close}
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
            <h2 className="title" translate="no">
              {s.name}
            </h2>
            <p className="lead">{s.description ?? m.noDescription}</p>
            <div className="sect">
              <h3>{m.matchesWhen}</h3>
            </div>
            {s.conditions.userIds.length > 0 && (
              <p>
                {m.keyIn(
                  <span className="mono">
                    {s.conditions.userIds.slice(0, 10).join(", ")}
                    {s.conditions.userIds.length > 10 ? ", …" : ""}
                  </span>,
                )}
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
              <h3>{m.flagsUsing}</h3>
            </div>
            {s.usage.flags.length === 0 ? (
              <p className="c3">{m.unused}</p>
            ) : (
              <ul className="feed">
                {s.usage.flags.map((f) => (
                  <li key={f.flagId}>
                    <span />
                    <span className="mono" translate="no">
                      {f.flagKey}
                    </span>
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
          title={m.deleteTitle(s.name)}
          description={m.deleteDescription}
          confirmLabel={m.deleteConfirm}
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
  const m = useMessages(segmentMessages);
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
      toast.info(m.saved);
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
  // [Plan #58 UX-39] Lưu hỏng: focus tới ô lỗi đầu tiên
  useEffect(() => {
    if (save.error !== null) {
      focusFirstInvalid(document.querySelector<HTMLElement>("[role=dialog]"));
    }
  }, [save.error]);

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
      title={segment === undefined ? m.create : m.editTitle(segment.name)}
      description={m.dialogDescription}
      onClose={onClose}
      wide
      footer={
        <>
          <button type="button" className="btn" data-close onClick={onClose}>
            {m.cancel}
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
            {save.isPending ? m.saving : m.save}
          </button>
        </>
      }
    >
      <Field id="seg-name" label={m.name} error={fields.name}>
        {(p) => (
          <input
            {...p}
            className="inp"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        )}
      </Field>
      <Field id="seg-desc" label={m.description} error={fields.description}>
        {(p) => (
          <input
            {...p}
            className="inp"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
        )}
      </Field>
      <div className="f">
        <span className="lbl">
          {m.keyInLabel}
          <InfoTip term="targetingKey" />
        </span>
        <TagInput
          label={m.keyList}
          values={userIds}
          readOnly={false}
          onChange={setUserIds}
        />
      </div>
      <div className="f">
        <span className="lbl">{m.orAll}</span>
        <AttributeConditions
          label={m.conditionsOf}
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
            ? m.over(
                formatBytes(verdict.projectedLower),
                formatBytes(quota.maxPayloadBytes),
              )
            : verdict.verdict === "maybe"
              ? m.maybe(
                  formatBytes(verdict.projectedLower),
                  formatBytes(quota.maxPayloadBytes),
                )
              : m.ok(
                  formatBytes(verdict.projectedLower),
                  formatBytes(quota.maxPayloadBytes),
                )}
        </p>
      )}
      {countFull && (
        <p className="field-error" role="alert">
          {m.countFull(quota?.segmentCount, quota?.maxSegments)}
        </p>
      )}
      {save.isError && (
        <p role="alert" className="field-error">
          {Object.entries(fields).find(
            ([key]) => key !== "name" && key !== "description",
          )?.[1] ?? messageOf(save.error)}
        </p>
      )}
    </Dialog>
  );
}
