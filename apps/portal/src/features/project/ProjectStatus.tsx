import type { PublicProjectWire } from "@udp/shared-types/wire";
import { StatusLabel, type Tone } from "../../components/StatusLabel";
import { useMessages } from "../../i18n";
import { projectStatusMessages } from "./project-status.messages";

/** Tone của trạng thái project — icon kèm chữ, không chấm màu (DESIGN.md §5); chữ ở messages */
export const PROJECT_STATUS_TONE: Record<PublicProjectWire["status"], Tone> = {
  DRAFT: "unknown",
  PROVISIONING: "running",
  ACTIVE: "ok",
  ERROR: "error",
  DELETED: "unknown",
};

/**
 * Trạng thái project, kèm nhãn hết hạn khi TTL đã qua (§4.4 lớp 3): với `WARN` máy chủ chỉ
 * cảnh báo và KHÔNG xoá, nên nhãn này là nơi duy nhất người dùng thấy project đã quá hạn.
 */
export function ProjectStatus({
  status,
  expiresAt = null,
  now = Date.now(),
}: {
  status: PublicProjectWire["status"];
  expiresAt?: string | null;
  now?: number;
}) {
  const m = useMessages(projectStatusMessages);
  const expired =
    expiresAt !== null &&
    status !== "DELETED" &&
    new Date(expiresAt).getTime() <= now;
  return (
    <>
      <StatusLabel tone={PROJECT_STATUS_TONE[status]}>
        {m.status[status]}
      </StatusLabel>
      {expired && <span className="chip soft">{m.expired}</span>}
    </>
  );
}
