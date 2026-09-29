import { Link } from "@tanstack/react-router";
import type {
  DomainCatalogEntryWire,
  ProjectDomainWire,
} from "@udp/shared-types/wire";
import { Switch } from "../../components/Switch";
import { ConfigForm } from "./ConfigForm";
import type { DraftEntry } from "./domain-model";
import { STATUS_LABEL } from "./domain-labels";

/**
 * Một domain trong trang cấu hình (§10.7 `DomainRow`): công tắc, chọn tool, trạng thái đã
 * lưu, và form cấu hình khi đang bật. Domain chưa có tool nào nói đúng điều đó thay vì một
 * công tắc bật được mà không làm gì.
 */
export function DomainRow({
  projectId,
  entry,
  draft,
  saved,
  canEdit,
  errors,
  onEnabled,
  onTool,
  onConfig,
}: {
  projectId: string;
  entry: DomainCatalogEntryWire;
  draft: DraftEntry;
  saved: ProjectDomainWire | undefined;
  canEdit: boolean;
  errors: Record<string, string>;
  onEnabled: (enabled: boolean) => void;
  onTool: (toolId: string) => void;
  onConfig: (config: Record<string, unknown>) => void;
}) {
  const tool = entry.tools.find((t) => t.toolId === draft.toolId);
  const noTools = entry.tools.length === 0;
  const id = `dom-${entry.domainType}`;
  return (
    <div className="dom-row" aria-label={entry.displayName}>
      <div className="r">
        <Switch
          checked={draft.enabled}
          onChange={onEnabled}
          label={`Bật ${entry.displayName}`}
          disabled={!canEdit || noTools || !entry.isAvailable}
        />
        <b>{entry.displayName}</b>
        {saved?.status !== null && saved?.status !== undefined && (
          <span className="chip soft">{STATUS_LABEL[saved.status]}</span>
        )}
        {saved?.status !== null && saved?.status !== undefined && (
          <Link
            to="/app/projects/$projectId/domains/$type"
            params={{ projectId, type: entry.domainType }}
            search={(prev: Record<string, unknown>) => prev}
            className="c3"
          >
            Chi tiết
          </Link>
        )}
      </div>
      {noTools && <p className="c3">Chưa có công cụ nào cho domain này.</p>}
      {draft.enabled && tool !== undefined && (
        <div className="form">
          {entry.tools.length > 1 && (
            <div className="f">
              <label htmlFor={`${id}-tool`}>Công cụ</label>
              <select
                id={`${id}-tool`}
                className="sel"
                disabled={!canEdit}
                value={tool.toolId}
                onChange={(e) => onTool(e.target.value)}
              >
                {entry.tools.map((t) => (
                  <option key={t.toolId} value={t.toolId}>
                    {t.toolId} {t.version}
                  </option>
                ))}
              </select>
            </div>
          )}
          {entry.tools.length === 1 && (
            <p className="c3">
              Công cụ: <b>{tool.toolId}</b> {tool.version}
            </p>
          )}
          <ConfigForm
            key={tool.toolId}
            idPrefix={id}
            tool={tool}
            value={draft.config}
            onChange={onConfig}
            disabled={!canEdit}
            errors={errors}
          />
        </div>
      )}
    </div>
  );
}
