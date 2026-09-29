import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  DomainVersionsWire,
  ProjectDomainWire,
} from "@udp/shared-types/wire";
import { RefreshCw, Rocket, RotateCcw } from "lucide-react";
import { useCallback, useState } from "react";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { Icon } from "../../components/Icon";
import { useMessages } from "../../i18n";
import { messageOf } from "../../lib/errors";
import { qk } from "../../lib/query-keys";
import { useProjectContext } from "../project/ProjectLayout";
import { can } from "../project/roles";
import { JobLog } from "../provisioning/JobLog";
import { domainApi } from "./domain-api";
import { domainMessages } from "./domain.messages";

type Dialog = "upgrade" | "retry" | null;

/**
 * Thao tác Day-2 của một domain (§8.6, §10.13, Plan #30, #45). MAINTAINER.
 *
 * - Quét drift NGAY (đồng bộ, chỉ đọc).
 * - Nâng lên bản adapter máy chủ đang nạp: hộp đọc `GET …/versions` và hiện capability đổi gì, kết
 *   quả chạy lại validator; validator đỏ thì không cho bấm (worker cũng sẽ từ chối).
 * - Áp lại cấu hình đang lưu: "Thử lại" cho domain lỗi, "Áp lại cấu hình mong muốn" cho domain đã
 *   trôi — người vận hành CHỌN ghi đè, hệ thống không tự sửa (§8.6).
 *
 * Chạm environment production thì gõ lại tên domain — máy chủ so lại (428). Job hiện tiến độ tại chỗ.
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
  const m = useMessages(domainMessages).actions;
  const maintainer = can(project.myRole, "MAINTAINER");
  const running = domain.status === "ACTIVE";
  const failed = domain.status === "ERROR" || domain.status === "BLOCKED";
  const drift = useQuery({
    queryKey: qk.domainDrift(project.id, type),
    queryFn: () => domainApi.drift(project.id, type),
    enabled: maintainer && running,
  });
  const versions = useQuery({
    queryKey: qk.domainVersions(project.id, type),
    queryFn: () => domainApi.versions(project.id, type),
    enabled: maintainer && running,
  });
  const [dialog, setDialog] = useState<Dialog>(null);
  const [job, setJob] = useState<string | null>(null);

  const scan = useMutation({
    mutationFn: () => domainApi.scanNow(project.id, type),
    onSuccess: (data) => {
      queryClient.setQueryData(qk.domainDrift(project.id, type), data);
    },
  });
  const started = ({ job: created }: { job: { id: string } }) => {
    setDialog(null);
    setJob(created.id);
  };
  const upgrade = useMutation({
    mutationFn: (v: { confirm: string | undefined; toVersion: string }) =>
      domainApi.upgrade(project.id, type, {
        toVersion: v.toVersion,
        ...(v.confirm === undefined ? {} : { confirm: v.confirm }),
      }),
    onSuccess: started,
  });
  const retry = useMutation({
    mutationFn: (confirm: string | undefined) =>
      domainApi.retry(
        project.id,
        type,
        confirm === undefined ? {} : { confirm },
      ),
    onSuccess: started,
  });
  const refresh = useCallback(() => {
    for (const queryKey of [
      qk.domain(project.id, type),
      qk.domainDrift(project.id, type),
      qk.domainVersions(project.id, type),
    ]) {
      void queryClient.invalidateQueries({ queryKey });
    }
  }, [queryClient, project.id, type]);

  if (!maintainer || (!running && !failed)) return null;
  const target = versions.data?.versions.available[0];
  const drifted = drift.data?.drift.verdict === "DRIFTED";
  const production = envs.some((e) => e.isProduction);
  const close = () => {
    setDialog(null);
    upgrade.reset();
    retry.reset();
  };

  return (
    <section aria-label={m.label}>
      <div className="form-actions" style={{ justifyContent: "flex-start" }}>
        {running && (
          <button
            type="button"
            className="btn"
            disabled={scan.isPending}
            onClick={() => scan.mutate()}
          >
            <Icon of={RefreshCw} />
            {scan.isPending ? m.scanning : m.scan}
          </button>
        )}
        {target !== undefined && (
          <button
            type="button"
            className="btn"
            onClick={() => setDialog("upgrade")}
          >
            <Icon of={Rocket} />
            {m.upgradeTo(target.version)}
          </button>
        )}
        {(failed || drifted) && (
          <button
            type="button"
            className="btn"
            onClick={() => setDialog("retry")}
          >
            <Icon of={RotateCcw} />
            {failed ? m.retry : m.reapply}
          </button>
        )}
      </div>
      {scan.isError && (
        <p role="alert" className="field-error">
          {messageOf(scan.error)}
        </p>
      )}
      {dialog === "upgrade" && target !== undefined && (
        <ConfirmDialog
          title={m.upgradeTitle(type, target.version)}
          description={m.upgradeDescription}
          confirmLabel={m.upgrade}
          {...(production ? { typeToConfirm: type } : {})}
          busy={upgrade.isPending}
          disabled={!target.validation.valid}
          error={upgrade.isError ? messageOf(upgrade.error) : undefined}
          onConfirm={(typed) =>
            upgrade.mutate({ confirm: typed, toVersion: target.version })
          }
          onClose={close}
        >
          <UpgradeDetails
            current={versions.data?.versions.current ?? null}
            target={target}
          />
        </ConfirmDialog>
      )}
      {dialog === "retry" && (
        <ConfirmDialog
          title={failed ? m.retryTitle(type) : m.reapplyTitle(type)}
          description={failed ? m.retryDescription : m.reapplyDescription}
          confirmLabel={failed ? m.retry : m.reapplyConfirm}
          danger={!failed}
          {...(production ? { typeToConfirm: type } : {})}
          busy={retry.isPending}
          error={retry.isError ? messageOf(retry.error) : undefined}
          onConfirm={(typed) => retry.mutate(typed)}
          onClose={close}
        />
      )}
      {job !== null && (
        <JobLog
          projectId={project.id}
          jobId={job}
          role={project.myRole}
          onTerminal={refresh}
        />
      )}
    </section>
  );
}

/** Capability đổi gì và validator nói gì — thứ người dùng cần thấy TRƯỚC khi bấm (§10.13) */
function UpgradeDetails({
  current,
  target,
}: {
  current: string | null;
  target: DomainVersionsWire["available"][number];
}) {
  const m = useMessages(domainMessages).actions;
  return (
    <div className="f" aria-label={m.details}>
      <p className="c3">
        {m.current(<span className="mono">{current ?? m.unknown}</span>)}
      </p>
      {target.changes.length === 0 ? (
        <p className="c3">{m.noChanges}</p>
      ) : (
        <ul aria-label={m.changes}>
          {target.changes.map((c) => (
            <li key={c.capabilityId}>
              <span className="mono">{c.capabilityId}</span>:{" "}
              {c.from === null
                ? m.added(String(c.to))
                : c.to === null
                  ? m.removed(c.from)
                  : `${c.from} → ${c.to}`}
            </li>
          ))}
        </ul>
      )}
      {target.validation.valid ? (
        <p className="c3">{m.stillValid}</p>
      ) : (
        <div role="alert" className="field-error">
          {m.rejected}
          <ul>
            {target.validation.errors.map((e) => (
              <li key={`${e.code}-${e.subject}`}>
                <span className="mono">{e.code}</span> {e.subject}:{" "}
                {e.detail.join(", ")}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
