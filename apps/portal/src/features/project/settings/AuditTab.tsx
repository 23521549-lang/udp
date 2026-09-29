import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useNavigate, useSearch } from "@tanstack/react-router";
import type { AuditEntryWire } from "@udp/shared-types/wire";
import { useCallback, useState } from "react";
import { Pager } from "../../../components/Pager";
import { Empty, ErrorState, Loading } from "../../../components/States";
import { useMessages } from "../../../i18n";
import { formatDateTime } from "../../../lib/format";
import { qk } from "../../../lib/query-keys";
import { useSearchInput } from "../../../lib/use-search-input";
import { useProjectContext } from "../ProjectLayout";
import { projectApi } from "../project-api";
import { settingsMessages } from "./settings.messages";

const AUDIT_PAGE_SIZE = 50;

/**
 * Nhật ký kiểm toán của project. Bộ lọc và trang nằm trên URL (`?tab=audit&action=…&offset=…`), bộ
 * lọc chỉ gửi đi khi ngừng gõ; trong lúc tải lại danh sách cũ vẫn hiện (Plan #53 QĐ-9) — không nháy
 * "Đang tải…" theo từng phím. Máy chủ trả `total`, nên dòng thứ 101 trở đi đọc được bằng trang sau.
 */
export function AuditTab() {
  const m = useMessages(settingsMessages).audit;
  const { project, envs } = useProjectContext();
  const search = useSearch({ from: "/app/projects/$projectId/settings" });
  const navigate = useNavigate();
  const applied = search.action ?? "";
  const offset = search.offset ?? 0;
  const [open, setOpen] = useState<string | null>(null);
  const commitAction = useCallback(
    (next: string) => {
      void navigate({
        to: ".",
        replace: true,
        search: (prev: Record<string, unknown>) => {
          const { action: _a, offset: _o, ...rest } = prev;
          return next === "" ? rest : { ...rest, action: next };
        },
      });
    },
    [navigate],
  );
  const [action, setAction] = useSearchInput(applied, commitAction);
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
  const envName = (id: string | null) =>
    id === null ? "" : (envs.find((e) => e.id === id)?.name ?? "");

  return (
    <section aria-label={m.label}>
      <div className="filters flush">
        <input
          className="inp"
          type="search"
          name="action"
          autoComplete="off"
          spellCheck={false}
          aria-label={m.filter}
          placeholder={m.filterPlaceholder}
          value={action}
          onChange={(e) => setAction(e.target.value)}
        />
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
  env,
  open,
  onToggle,
}: {
  entry: AuditEntryWire;
  env: string;
  open: boolean;
  onToggle: () => void;
}) {
  const m = useMessages(settingsMessages).audit;
  return (
    <div className="it" role="listitem" style={{ flexWrap: "wrap" }}>
      <button
        type="button"
        className="rowbtn"
        aria-expanded={open}
        onClick={onToggle}
      >
        <span className="mono" translate="no">
          {entry.action}
        </span>
      </button>
      <span className="c3">{entry.targetType}</span>
      {env !== "" && <span className="chip soft">{env}</span>}
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
