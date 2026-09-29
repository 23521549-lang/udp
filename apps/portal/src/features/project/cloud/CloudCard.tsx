import { Link } from "@tanstack/react-router";
import type { ArchitectureWire, ProjectRoleWire } from "@udp/shared-types/wire";
import { Cloud } from "lucide-react";
import { Icon } from "../../../components/Icon";
import { StatusLabel } from "../../../components/StatusLabel";
import { relativeTime } from "../../../lib/format";
import { can } from "../roles";
import { AUTH_KIND_LABEL, PROVIDER_LABEL } from "./cloud-labels";

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
  const owner = can(role, "OWNER");
  return (
    <section className="kpi cloud-card" aria-label="Cloud">
      <div className="l">
        <span className="tile">
          <Icon of={Cloud} />
        </span>
        Cloud
      </div>
      {cloud === null ? (
        <>
          <p className="c3">
            Chưa kết nối cloud. Project dựng hạ tầng trên tài khoản cloud của
            bạn (BYOC).
          </p>
          {owner && (
            <Link
              to="/app/projects/$projectId/settings"
              params={{ projectId }}
              search={{ tab: "cloud" }}
              className="btn pri"
            >
              Kết nối cloud
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
            <dt>Xác thực</dt>
            <dd>{AUTH_KIND_LABEL[cloud.authKind]}</dd>
            <dt>Kiểm lần cuối</dt>
            <dd>
              {cloud.lastValidatedAt === null ? (
                <StatusLabel tone="warn">Chưa kiểm</StatusLabel>
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
              {owner ? "Đổi cloud" : "Xem cấu hình cloud"}
            </Link>
          )}
        </>
      )}
    </section>
  );
}
