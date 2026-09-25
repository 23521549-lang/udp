import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ProjectDomainWire } from "@udp/shared-types/wire";
import { RefreshCw, Rocket } from "lucide-react";
import { useCallback, useState } from "react";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { Icon } from "../../components/Icon";
import { messageOf } from "../../lib/errors";
import { qk } from "../../lib/query-keys";
import { useProjectContext } from "../project/ProjectLayout";
import { can } from "../project/roles";
import { JobLog } from "../provisioning/JobLog";
import { domainApi } from "./domain-api";

/**
 * Hai thao tác Day-2 của một domain đang chạy (§8.6, Plan #30): quét drift NGAY (đồng bộ,
 * chỉ đọc) và nâng lên bản adapter máy chủ đang nạp (job, tiến độ hiện tại chỗ). MAINTAINER.
 * Nâng cấp chạm environment production thì phải gõ lại tên domain — máy chủ so lại (428).
 */
export function DomainActions({
  type,
  domain,
}: {
  type: string;
  domain: ProjectDomainWire;
}) {
  const { project, envs } = useProjectContext();
  const queryClient = useQueryClient();
  const allowed =
    can(project.myRole, "MAINTAINER") && domain.status === "ACTIVE";
  // Bản adapter máy chủ đang nạp — chỉ hỏi khi có nút nào để hiện
  const catalog = useQuery({
    queryKey: qk.catalog(),
    queryFn: domainApi.catalog,
    staleTime: Infinity,
    enabled: allowed,
  });
  const [confirming, setConfirming] = useState(false);
  const [upgradeJob, setUpgradeJob] = useState<string | null>(null);

  const scan = useMutation({
    mutationFn: () => domainApi.scanNow(project.id, type),
    onSuccess: (data) => {
      queryClient.setQueryData(qk.domainDrift(project.id, type), data);
    },
  });
  const upgrade = useMutation({
    mutationFn: (confirm: string | undefined) =>
      domainApi.upgrade(
        project.id,
        type,
        confirm === undefined ? {} : { confirm },
      ),
    onSuccess: ({ job }) => {
      setConfirming(false);
      setUpgradeJob(job.id);
    },
  });
  const refresh = useCallback(() => {
    void queryClient.invalidateQueries({
      queryKey: qk.domain(project.id, type),
    });
  }, [queryClient, project.id, type]);

  if (!allowed) return null;
  const latest = catalog.data?.domains
    .find((d) => d.domainType === type)
    ?.tools.find((t) => t.toolId === domain.selectedTool)?.version;
  const upgradable = latest !== undefined && latest !== domain.adapterVersion;
  const production = envs.some((e) => e.isProduction);

  return (
    <section aria-label="Thao tác Day-2">
      <div className="form-actions" style={{ justifyContent: "flex-start" }}>
        <button
          type="button"
          className="btn"
          disabled={scan.isPending}
          onClick={() => scan.mutate()}
        >
          <Icon of={RefreshCw} />
          {scan.isPending ? "Đang quét..." : "Quét drift ngay"}
        </button>
        {upgradable && (
          <button
            type="button"
            className="btn"
            onClick={() => setConfirming(true)}
          >
            <Icon of={Rocket} />
            Nâng cấp lên {latest}
          </button>
        )}
      </div>
      {scan.isError && (
        <p role="alert" className="field-error">
          {messageOf(scan.error)}
        </p>
      )}
      {confirming && (
        <ConfirmDialog
          title={`Nâng cấp ${type} lên ${String(latest)}?`}
          description="Cấu hình capability được kiểm lại trước khi chạm cluster; nâng xong mà không khoẻ thì UDP báo lỗi to thay vì để lửng."
          confirmLabel="Nâng cấp"
          {...(production ? { typeToConfirm: type } : {})}
          busy={upgrade.isPending}
          error={upgrade.isError ? messageOf(upgrade.error) : undefined}
          onConfirm={(typed) => upgrade.mutate(typed)}
          onClose={() => {
            setConfirming(false);
            upgrade.reset();
          }}
        />
      )}
      {upgradeJob !== null && (
        <JobLog
          projectId={project.id}
          jobId={upgradeJob}
          role={project.myRole}
          onTerminal={refresh}
        />
      )}
    </section>
  );
}
