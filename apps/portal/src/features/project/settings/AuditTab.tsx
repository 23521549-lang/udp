import { useQuery } from "@tanstack/react-query";
import type { AuditEntryWire } from "@udp/shared-types/wire";
import { useState } from "react";
import { Empty, ErrorState, Loading } from "../../../components/States";
import { formatDateTime } from "../../../lib/format";
import { qk } from "../../../lib/query-keys";
import { useProjectContext } from "../ProjectLayout";
import { projectApi } from "../project-api";

export function AuditTab() {
  const { project, envs } = useProjectContext();
  const [action, setAction] = useState("");
  const [open, setOpen] = useState<string | null>(null);
  const filters = {
    action: action.trim() === "" ? undefined : action.trim(),
    limit: "100",
  };
  const audit = useQuery({
    queryKey: qk.audit(project.id, filters),
    queryFn: () => projectApi.audit(project.id, filters),
  });
  const envName = (id: string | null) =>
    id === null ? "" : (envs.find((e) => e.id === id)?.name ?? "");

  return (
    <section aria-label="Nhật ký kiểm toán">
      <div className="filters" style={{ padding: "0 0 10px" }}>
        <input
          className="inp"
          aria-label="Lọc theo hành động"
          placeholder="Hành động, ví dụ flag.update"
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
        <div className="lst">
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
    <div className="it" style={{ flexWrap: "wrap" }}>
      <button
        type="button"
        className="rowbtn"
        aria-expanded={open}
        onClick={onToggle}
      >
        <span className="mono">{entry.action}</span>
      </button>
      <span className="c3">{entry.targetType}</span>
      {env !== "" && <span className="chip soft">{env}</span>}
      <span
        className="c3"
        style={{ marginLeft: "auto" }}
        title={entry.occurredAt}
      >
        {formatDateTime(entry.occurredAt)}
      </span>
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
