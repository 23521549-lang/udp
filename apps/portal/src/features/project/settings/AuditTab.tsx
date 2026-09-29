import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useNavigate, useSearch } from "@tanstack/react-router";
import type { AuditEntryWire } from "@udp/shared-types/wire";
import { useEffect, useState } from "react";
import { Empty, ErrorState, Loading } from "../../../components/States";
import { formatDateTime } from "../../../lib/format";
import { qk } from "../../../lib/query-keys";
import { useProjectContext } from "../ProjectLayout";
import { projectApi } from "../project-api";

const FILTER_DEBOUNCE_MS = 300;

/**
 * Nhật ký kiểm toán của project. Bộ lọc nằm trên URL (`?tab=audit&action=…`) và chỉ gửi đi khi ngừng
 * gõ; trong lúc tải lại danh sách cũ vẫn hiện (Plan #53 QĐ-9) — không nháy "Đang tải…" theo từng phím.
 */
export function AuditTab() {
  const { project, envs } = useProjectContext();
  const search = useSearch({ from: "/app/projects/$projectId/settings" });
  const navigate = useNavigate();
  const applied = search.action ?? "";
  const [action, setAction] = useState(applied);
  const [open, setOpen] = useState<string | null>(null);

  useEffect(() => {
    const next = action.trim();
    if (next === applied) return;
    const t = setTimeout(() => {
      void navigate({
        to: ".",
        replace: true,
        search: (prev: Record<string, unknown>) => {
          const { action: _a, offset: _o, ...rest } = prev;
          return next === "" ? rest : { ...rest, action: next };
        },
      });
    }, FILTER_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [action, applied, navigate]);

  const filters = {
    action: applied === "" ? undefined : applied,
    limit: "100",
  };
  const audit = useQuery({
    queryKey: qk.audit(project.id, filters),
    queryFn: () => projectApi.audit(project.id, filters),
    placeholderData: keepPreviousData,
  });
  const envName = (id: string | null) =>
    id === null ? "" : (envs.find((e) => e.id === id)?.name ?? "");

  return (
    <section aria-label="Nhật ký kiểm toán">
      <div className="filters" style={{ padding: "0 0 10px" }}>
        <input
          className="inp"
          type="search"
          name="action"
          autoComplete="off"
          spellCheck={false}
          aria-label="Lọc theo hành động"
          placeholder="Hành động, ví dụ flag.update…"
          value={action}
          onChange={(e) => setAction(e.target.value)}
        />
      </div>
      {audit.isPending ? (
        <Loading />
      ) : audit.isError ? (
        <ErrorState error={audit.error} onRetry={() => void audit.refetch()} />
      ) : audit.data.entries.length === 0 ? (
        <Empty title="Không có dòng nào" />
      ) : (
        <div
          className="lst"
          role="list"
          aria-label="Nhật ký"
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
            <div className="c3">Trước</div>
            <pre className="mono">
              {entry.before === undefined || entry.before === null
                ? "–"
                : JSON.stringify(entry.before, null, 2)}
            </pre>
          </div>
          <div>
            <div className="c3">Sau</div>
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
