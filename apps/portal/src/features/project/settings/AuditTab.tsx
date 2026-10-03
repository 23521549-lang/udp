import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useNavigate, useSearch } from "@tanstack/react-router";
import type { AuditEntryWire, PublicMemberWire } from "@udp/shared-types/wire";
import { useState } from "react";
import { Pager } from "../../../components/Pager";
import { Empty, ErrorState, Loading } from "../../../components/States";
import { useMessages } from "../../../i18n";
import { formatDateTime } from "../../../lib/format";
import { qk } from "../../../lib/query-keys";
import { useProjectContext } from "../ProjectLayout";
import { projectApi } from "../project-api";
import {
  AUDIT_GROUPS,
  auditActor,
  auditOptionLabel,
  auditSentence,
  auditTarget,
  type AuditGroup,
} from "./audit-labels";
import { auditMessages } from "./audit.messages";
import { settingsMessages } from "./settings.messages";

const AUDIT_PAGE_SIZE = 50;
const GROUPS = Object.keys(AUDIT_GROUPS) as AuditGroup[];
const KNOWN = new Set<string>(Object.values(AUDIT_GROUPS).flat());

/**
 * Nhật ký kiểm toán của project. Bộ lọc và trang nằm trên URL (`?tab=audit&action=…&offset=…`); trong lúc tải lại
 * danh sách cũ vẫn hiện (Plan #53 QĐ-9).
 *
 * [Plan #58 UX-35] Mỗi dòng đọc thành câu: AI làm (tên thành viên, tra từ danh sách thành viên), LÀM GÌ (câu thay
 * cho mã `flag.rules.update`) và VỚI CÁI GÌ (key, tên, email). Lọc bằng danh sách hành động xếp theo nhóm thay cho ô
 * gõ mã: người dùng không phải biết mã của máy chủ.
 */
export function AuditTab() {
  const m = useMessages(settingsMessages).audit;
  const a = useMessages(auditMessages);
  const { project, envs } = useProjectContext();
  const search = useSearch({ from: "/app/projects/$projectId/settings" });
  const navigate = useNavigate();
  const applied = search.action ?? "";
  const offset = search.offset ?? 0;
  const [open, setOpen] = useState<string | null>(null);
  const setAction = (next: string): void => {
    void navigate({
      to: ".",
      replace: true,
      search: (prev: Record<string, unknown>) => {
        const { action: _a, offset: _o, ...rest } = prev;
        return next === "" ? rest : { ...rest, action: next };
      },
    });
  };
  const setOffset = (n: number): void => {
    void navigate({
      to: ".",
      search: (prev: Record<string, unknown>) => {
        const { offset: _o, ...rest } = prev;
        return n === 0 ? rest : { ...rest, offset: n };
      },
    });
  };

  const filters = {
    action: applied === "" ? undefined : applied,
    limit: String(AUDIT_PAGE_SIZE),
    offset: offset === 0 ? undefined : String(offset),
  };
  const audit = useQuery({
    queryKey: qk.audit(project.id, filters),
    queryFn: () => projectApi.audit(project.id, filters),
    placeholderData: keepPreviousData,
  });
  // Cùng key với tab Thành viên: tên người làm; thiếu (lỗi, đang tải) thì dòng vẫn hiện, gọi bằng mã ngắn
  const members = useQuery({
    queryKey: qk.members(project.id),
    queryFn: () => projectApi.members(project.id),
  });
  const people = members.data?.members ?? [];
  const envName = (id: string | null) =>
    id === null ? "" : (envs.find((e) => e.id === id)?.name ?? "");

  return (
    <section aria-label={m.label}>
      <div className="filters flush">
        <select
          className="sel"
          name="action"
          aria-label={a.filter}
          value={applied}
          onChange={(e) => setAction(e.target.value)}
        >
          <option value="">{a.allActions}</option>
          {GROUPS.map((g) => (
            <optgroup key={g} label={a.group[g]}>
              {AUDIT_GROUPS[g].map((code) => (
                <option key={code} value={code}>
                  {auditOptionLabel(code)}
                </option>
              ))}
            </optgroup>
          ))}
          {/* Link cũ mang mã không có trong danh sách: vẫn chọn được đúng nó */}
          {applied !== "" && !KNOWN.has(applied) && (
            <option value={applied}>{applied}</option>
          )}
        </select>
      </div>
      {audit.isPending ? (
        <Loading />
      ) : audit.isError ? (
        <ErrorState error={audit.error} onRetry={() => void audit.refetch()} />
      ) : audit.data.entries.length === 0 ? (
        <Empty title={m.empty} />
      ) : (
        <div
          className="lst"
          role="list"
          aria-label={m.list}
          aria-busy={audit.isFetching}
        >
          {audit.data.entries.map((e) => (
            <AuditRow
              key={e.id}
              entry={e}
              members={people}
              env={envName(e.environmentId)}
              open={open === e.id}
              onToggle={() => setOpen(open === e.id ? null : e.id)}
            />
          ))}
        </div>
      )}
      <Pager
        label={m.pages}
        offset={offset}
        pageSize={AUDIT_PAGE_SIZE}
        total={audit.data?.total ?? 0}
        onChange={setOffset}
      />
    </section>
  );
}

function AuditRow({
  entry,
  members,
  env,
  open,
  onToggle,
}: {
  entry: AuditEntryWire;
  members: readonly PublicMemberWire[];
  env: string;
  open: boolean;
  onToggle: () => void;
}) {
  const m = useMessages(settingsMessages).audit;
  const sentence = auditSentence(entry, members);
  return (
    <div className="it audit-it" role="listitem">
      <button
        type="button"
        className="rowbtn"
        aria-expanded={open}
        onClick={onToggle}
      >
        {sentence ?? (
          <>
            {auditActor(entry, members)}{" "}
            <span className="mono" translate="no">
              {entry.action}
            </span>
          </>
        )}
      </button>
      <span className="mono c3" translate="no">
        {auditTarget(entry, members)}
      </span>
      {env !== "" && (
        <span className="chip soft" translate="no">
          {env}
        </span>
      )}
      <span className="c3 lst-end">{formatDateTime(entry.occurredAt)}</span>
      {open && (
        <div className="diff">
          <div>
            <div className="c3">{m.before}</div>
            <pre className="mono">
              {entry.before === undefined || entry.before === null
                ? "–"
                : JSON.stringify(entry.before, null, 2)}
            </pre>
          </div>
          <div>
            <div className="c3">{m.after}</div>
            <pre className="mono">
              {entry.after === undefined || entry.after === null
                ? "–"
                : JSON.stringify(entry.after, null, 2)}
            </pre>
          </div>
        </div>
      )}
    </div>
  );
}
