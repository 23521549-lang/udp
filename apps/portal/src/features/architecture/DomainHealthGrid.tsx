import { Link } from "@tanstack/react-router";
import type { ArchitectureToolWire } from "@udp/shared-types/wire";
import { StatusLabel } from "../../components/StatusLabel";
import { useMessages } from "../../i18n";
import { formatDateTime } from "../../lib/format";
import { bySeverity, toolHealth } from "./architecture-model";
import { architectureMessages } from "./architecture.messages";

/**
 * Lưới sức khoẻ domain (§10.6 `DomainHealthGrid`; DESIGN.md §6 "Lưới sức khoẻ"): mỗi ô một domain đang
 * bật — tên, tool, trạng thái bằng icon và chữ, drift. Ô không có nền màu; bấm vào tới trang của domain
 * đó (drift, phiên bản, áp lại). Ô lỗi đứng trước: thứ cần xem không bị chìm giữa mười ô xanh.
 */
export function DomainHealthGrid({
  projectId,
  tools,
  env,
}: {
  projectId: string;
  tools: readonly ArchitectureToolWire[];
  /** Giữ env đang chọn khi sang trang domain */
  env: string | undefined;
}) {
  const m = useMessages(architectureMessages).grid;
  const sorted = [...tools].sort(bySeverity);
  return (
    <ul className="health-grid" aria-label={m.label}>
      {sorted.map((t) => {
        const health = toolHealth(t);
        return (
          <li key={t.key}>
            <Link
              to="/app/projects/$projectId/domains/$type"
              params={{ projectId, type: t.domainType }}
              search={env === undefined ? {} : { env }}
              className="health-cell"
            >
              <b className="health-name">{t.displayName}</b>
              <span className="mono c3" translate="no">
                {t.toolId}
                {t.adapterVersion !== null && ` ${t.adapterVersion}`}
              </span>
              <StatusLabel tone={health.tone}>{health.label}</StatusLabel>
              {t.drift.verdict === "DRIFTED" && t.drift.at !== null && (
                <span className="c3 health-note">
                  {m.detectedAt(formatDateTime(t.drift.at))}
                </span>
              )}
            </Link>
          </li>
        );
      })}
    </ul>
  );
}
