import { Link } from "@tanstack/react-router";
import type { ArchitectureWire, ProjectRoleWire } from "@udp/shared-types/wire";
import { Cloud } from "lucide-react";
import { Icon } from "../../../components/Icon";
import { StatusLabel } from "../../../components/StatusLabel";
import { useMessages } from "../../../i18n";
import { relativeTime } from "../../../lib/format";
import { can } from "../roles";
import { cloudMessages } from "./cloud.messages";
import { PROVIDER_LABEL } from "./cloud-labels";

/**
 * Thẻ Cloud ở Tổng quan (§10.6 "Cloud badge", Plan #53 QĐ-7): cloud đang dùng hiện ngay ở trang đầu
 * của project, kèm lối đổi — trước đây nó nằm ở tab thứ năm của Cài đặt và người dùng không tìm ra.
 * Đổi cloud là việc của OWNER (§4.3); vai khác thấy nút xem.
 */
export function CloudCard({
  projectId,
  role,
  cloud,
}: {
  projectId: string;
  role: ProjectRoleWire;
  cloud: ArchitectureWire["cloud"];
}) {
  const m = useMessages(cloudMessages);
  const owner = can(role, "OWNER");
  return (
    <section className="kpi cloud-card" aria-label={m.cloud}>
      <div className="l">
        <span className="tile">
          <Icon of={Cloud} />
        </span>
        {m.cloud}
      </div>
      {cloud === null ? (
        <>
          <p className="c3">{m.card.notConnected}</p>
          {owner && (
            <Link
              to="/app/projects/$projectId/settings"
              params={{ projectId }}
              search={{ tab: "cloud" }}
              className="btn pri"
            >
              {m.card.connect}
            </Link>
          )}
        </>
      ) : (
        <>
          <div className="cloud-main">
            <b>{PROVIDER_LABEL[cloud.provider]}</b>
            <span className="mono c3" translate="no">
              {cloud.region}
            </span>
            <span className="chip soft">{cloud.mode}</span>
          </div>
          <dl className="props compact">
            <dt>{m.auth}</dt>
            <dd>{m.authKind[cloud.authKind]}</dd>
            <dt>{m.lastChecked}</dt>
            <dd>
              {cloud.lastValidatedAt === null ? (
                <StatusLabel tone="warn">{m.notChecked}</StatusLabel>
              ) : (
                <StatusLabel tone="ok">
                  {relativeTime(cloud.lastValidatedAt)}
                </StatusLabel>
              )}
            </dd>
          </dl>
          {/* Tab Cloud đọc được từ MAINTAINER (credential là của project, §4.3); đổi là của OWNER */}
          {can(role, "MAINTAINER") && (
            <Link
              to="/app/projects/$projectId/settings"
              params={{ projectId }}
              search={{ tab: "cloud" }}
              className="btn"
            >
              {owner ? m.card.change : m.card.view}
            </Link>
          )}
        </>
      )}
    </section>
  );
}
