import { useQuery } from "@tanstack/react-query";
import type { ProjectRoleWire } from "@udp/shared-types/wire";
import { Lock } from "lucide-react";
import { Icon } from "../../../components/Icon";
import { ErrorState, Loading } from "../../../components/States";
import { useMessages } from "../../../i18n";
import { qk } from "../../../lib/query-keys";
import { can } from "../roles";
import { cloudApi } from "./cloud-api";
import { cloudMessages } from "./cloud.messages";
import { CloudEditor } from "./CloudEditor";
import { CloudStatus } from "./CloudStatus";

/**
 * Bước cloud (§10.5 bước 2, Plan #26 AC-10) — một thành phần cho cả wizard và thẻ Cloud
 * trong Cài đặt. Quyền theo QĐ-7: MAINTAINER xem cấu hình và khối lệnh; chỉ OWNER lưu và
 * kiểm credential (máy chủ vẫn là nơi chặn thật).
 */
export function CloudPanel({
  projectId,
  role,
  onSaved,
}: {
  projectId: string;
  role: ProjectRoleWire;
  onSaved?: () => void;
}) {
  const m = useMessages(cloudMessages).panel;
  const canRead = can(role, "MAINTAINER");
  const isOwner = can(role, "OWNER");
  const current = useQuery({
    queryKey: qk.cloud(projectId),
    queryFn: () => cloudApi.get(projectId),
    enabled: canRead,
  });

  if (!canRead) {
    return (
      <div className="lock" role="note">
        <Icon of={Lock} />
        <span>{m.locked}</span>
      </div>
    );
  }
  if (current.isPending) return <Loading />;
  if (current.isError) return <ErrorState error={current.error} />;

  const cloud = current.data.cloud;
  return (
    <>
      {cloud === null ? (
        <p className="c3">{m.none}</p>
      ) : (
        <CloudStatus projectId={projectId} cloud={cloud} canCheck={isOwner} />
      )}
      <h2 className="h2">{cloud === null ? m.choose : m.change}</h2>
      <CloudEditor
        projectId={projectId}
        canEdit={isOwner}
        initialProvider={cloud?.provider ?? "AWS"}
        {...(onSaved === undefined ? {} : { onSaved })}
      />
    </>
  );
}
