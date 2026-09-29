import { useQuery } from "@tanstack/react-query";
import {
  CircleAlert,
  CircleCheck,
  CircleHelp,
  type LucideIcon,
} from "lucide-react";
import { Icon } from "../../../components/Icon";
import { ErrorState, Loading } from "../../../components/States";
import { formatDateTime } from "../../../lib/format";
import { qk } from "../../../lib/query-keys";
import { adminApi } from "../admin-api";

import { AdminPage } from "../AdminLayout";
const STATUS_VIEW: Record<
  "up" | "down" | "unknown",
  { label: string; icon: LucideIcon; tone: string }
> = {
  up: { label: "Ổn định", icon: CircleCheck, tone: "var(--green)" },
  down: { label: "Không phản hồi", icon: CircleAlert, tone: "var(--red)" },
  unknown: { label: "Không rõ", icon: CircleHelp, tone: "var(--ink-3)" },
};

export function AdminSystemPage() {
  const system = useQuery({
    queryKey: qk.adminSystem(),
    queryFn: adminApi.system,
    refetchInterval: 30_000,
  });
  return (
    <AdminPage
      title="Hệ thống"
      lead="Sức khoẻ ba service và database, tự cập nhật mỗi 30 giây."
    >
      {system.isPending ? (
        <Loading />
      ) : system.isError ? (
        <ErrorState
          error={system.error}
          onRetry={() => void system.refetch()}
        />
      ) : (
        <div className="lst" aria-label="Sức khoẻ">
          {[
            ...system.data.services,
            { name: "database", status: system.data.database },
          ].map((s) => {
            const v = STATUS_VIEW[s.status];
            return (
              <div key={s.name} className="it">
                <span className="mono">{s.name}</span>
                <span className="stt" style={{ marginLeft: "auto" }}>
                  <Icon of={v.icon} style={{ color: v.tone }} />
                  {v.label}
                </span>
              </div>
            );
          })}
          <div className="it c3">
            Kiểm lúc {formatDateTime(system.data.checkedAt)}
          </div>
        </div>
      )}
    </AdminPage>
  );
}
