import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  DomainCatalogEntryWire,
  ProjectDomainsResponseWire,
  ProjectRoleWire,
} from "@udp/shared-types/wire";
import { useCallback, useEffect, useMemo, useState } from "react";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { ErrorState, Loading } from "../../components/States";
import { toast } from "../../components/Toast";
import { UnsavedGuard } from "../../components/UnsavedGuard";
import { messagesOf, useMessages } from "../../i18n";
import { fieldErrorsOf, messageOf } from "../../lib/errors";
import { isApiError } from "../../lib/http";
import { qk } from "../../lib/query-keys";
import { can } from "../project/roles";
import { JobLog } from "../provisioning/JobLog";
import { domainApi } from "./domain-api";
import { domainMessages } from "./domain.messages";
import {
  changesOf,
  chooseTool,
  choosePreference,
  draftFrom,
  type DomainChange,
  enableSuggested,
  sameTarget,
  setConfig,
  setEnabled,
  targetOf,
  type DomainDraft,
} from "./domain-model";
import { tierLabel, toolNamer } from "./domain-labels";
import { DomainRow } from "./DomainRow";
import { ValidationPanel } from "./ValidationPanel";

/**
 * Cấu hình domain của project (§10.7, §10.12; Plan #27) — một thành phần cho trang Domain và
 * bước 3 của wizard. Quyền theo QĐ-7: VIEWER xem, DEVELOPER thử và kiểm, MAINTAINER lưu.
 */
export function DomainPanel({
  projectId,
  role,
  live,
  level,
  onSaved,
}: {
  projectId: string;
  role: ProjectRoleWire;
  /**
   * Project đang chạy (ACTIVE): lưu là ÁP lên cluster thật — bật, tắt, đổi tool — nên phải xác nhận
   * kèm danh sách thay đổi. Trong wizard (DRAFT) lưu chỉ ghi cấu hình, không cần hỏi.
   */
  live: boolean;
  /** Bậc tiêu đề của nhóm domain theo chỗ đặt: trang Domain (h1 → h2), wizard (h2 → h3) */
  level: 2 | 3;
  onSaved?: () => void;
}) {
  const catalog = useQuery({
    queryKey: qk.catalog(),
    queryFn: domainApi.catalog,
    staleTime: Infinity,
  });
  const saved = useQuery({
    queryKey: qk.domains(projectId),
    queryFn: () => domainApi.list(projectId),
  });
  const queryClient = useQueryClient();
  const m = useMessages(domainMessages).panel;
  /**
   * Job áp cấu hình của project ĐANG chạy — giữ ở đây, ngoài `key` của trình sửa: khoá
   * `domain_set_version` tăng ngay khi lưu nên trình sửa dựng lại, còn tiến độ phải ở lại.
   */
  const [applying, setApplying] = useState<string | null>(null);
  const refresh = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: qk.domains(projectId) });
  }, [queryClient, projectId]);
  if (catalog.isPending || saved.isPending) return <Loading />;
  if (catalog.isError) {
    return (
      <ErrorState
        error={catalog.error}
        onRetry={() => void catalog.refetch()}
      />
    );
  }
  if (saved.isError) {
    return (
      <ErrorState error={saved.error} onRetry={() => void saved.refetch()} />
    );
  }
  return (
    <>
      {applying !== null && (
        <section aria-label={m.applying}>
          <p className="lead">{m.applyingLead}</p>
          <JobLog
            projectId={projectId}
            jobId={applying}
            role={role}
            onTerminal={refresh}
          />
        </section>
      )}
      <DomainEditor
        // Mỗi lần lưu (hay tải lại sau xung đột) dựng lại bản nháp từ bản mới nhất
        key={saved.data.domainSetVersion}
        projectId={projectId}
        catalog={catalog.data.domains}
        saved={saved.data}
        canTry={can(role, "DEVELOPER")}
        canSave={can(role, "MAINTAINER")}
        live={live}
        level={level}
        onApplying={setApplying}
        {...(onSaved === undefined ? {} : { onSaved })}
      />
    </>
  );
}

/**
 * Một dòng của hộp xác nhận: "Bật Monitoring (prometheus-grafana)". Đọc ngôn ngữ lúc gọi; gọi trong lúc
 * render của `DomainEditor`, vốn đã theo dõi ngôn ngữ.
 */
function describeChange(
  change: DomainChange,
  catalog: readonly DomainCatalogEntryWire[],
): string {
  const t = messagesOf(domainMessages).panel.change;
  const domain =
    catalog.find((c) => c.domainType === change.domainType)?.displayName ??
    change.domainType;
  switch (change.kind) {
    case "enable":
      return t.enable(domain, change.toolId);
    case "disable":
      return t.disable(domain, change.toolId);
    case "switch":
      return t.switch(domain, change.from, change.to);
    case "config":
      return t.config(domain, change.toolId);
  }
}

const DEBOUNCE_MS = 400;

/** §10.12: kiểm trực tiếp sau 400 ms không gõ; bản nháp không đổi thì không hỏi lại */
function useLiveValidation(
  projectId: string,
  draft: DomainDraft,
  enabled: boolean,
) {
  const target = JSON.stringify(targetOf(draft));
  const [settled, setSettled] = useState(target);
  useEffect(() => {
    const t = setTimeout(() => setSettled(target), DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [target]);
  return useQuery({
    queryKey: qk.domainValidation(projectId, settled),
    queryFn: () => domainApi.validate(projectId, targetOf(draft)),
    enabled,
  });
}

/** Lỗi trường `domains.<i>.config.<key>` ⇒ theo domain, vì `i` là vị trí trong trạng thái đích */
function errorsByDomain(
  error: unknown,
  draft: DomainDraft,
): Record<string, Record<string, string>> {
  const domains = targetOf(draft).domains;
  const out: Record<string, Record<string, string>> = {};
  for (const [field, message] of Object.entries(fieldErrorsOf(error))) {
    const m = /^domains\.(\d+)\.config\.?(.*)$/.exec(field);
    const domainType =
      m === null ? undefined : domains[Number(m[1])]?.domainType;
    if (domainType === undefined) continue;
    (out[domainType] ??= {})[m?.[2] ?? ""] = message;
  }
  return out;
}

function DomainEditor({
  projectId,
  catalog,
  saved,
  canTry,
  canSave,
  live,
  level,
  onApplying,
  onSaved,
}: {
  projectId: string;
  catalog: readonly DomainCatalogEntryWire[];
  saved: ProjectDomainsResponseWire;
  canTry: boolean;
  canSave: boolean;
  live: boolean;
  level: 2 | 3;
  onApplying: (jobId: string) => void;
  onSaved?: () => void;
}) {
  const queryClient = useQueryClient();
  const m = useMessages(domainMessages).panel;
  const initial = useMemo(() => draftFrom(catalog, saved), [catalog, saved]);
  const [draft, setDraft] = useState(initial);
  const [confirming, setConfirming] = useState(false);
  const dirty = !sameTarget(draft, initial);
  const changes = useMemo(() => changesOf(initial, draft), [initial, draft]);
  const Heading = `h${String(level)}` as "h2" | "h3";
  const nameOf = useMemo(() => toolNamer(catalog), [catalog]);
  const validation = useLiveValidation(projectId, draft, canTry && dirty);

  const save = useMutation({
    mutationFn: () =>
      domainApi.put(projectId, {
        ...targetOf(draft),
        lastKnownDomainSetVersion: saved.domainSetVersion,
      }),
    onSuccess: ({ job, ...current }) => {
      setConfirming(false);
      queryClient.setQueryData(qk.domains(projectId), current);
      if (job === null) {
        toast.info(m.saved);
      } else {
        toast.info(m.applyingToast);
        onApplying(job.id);
      }
      onSaved?.();
    },
    onError: async (error) => {
      setConfirming(false);
      if (isApiError(error) && error.code === "OPTIMISTIC_LOCK") {
        toast.error(messageOf(error));
        await queryClient.invalidateQueries({
          queryKey: qk.domains(projectId),
        });
      }
    },
  });

  const fieldErrors = {
    ...errorsByDomain(validation.error, draft),
    ...errorsByDomain(save.error, draft),
  };
  const byType = new Map(saved.domains.map((d) => [d.domainType, d]));
  const tiers = (["CORE", "STANDARD", "ADVANCED"] as const).map((tier) => ({
    tier,
    entries: catalog.filter((c) => c.tier === tier),
  }));

  const discard = () => {
    const before = draft;
    setDraft(initial);
    toast.info(m.discarded, () => setDraft(before));
  };
  const submit = () => {
    if (live) setConfirming(true);
    else save.mutate();
  };

  return (
    <section aria-label={m.section}>
      <UnsavedGuard dirty={dirty} what={m.unsaved} />
      {tiers.map(({ tier, entries }) =>
        entries.length === 0 ? null : (
          <div key={tier} className="dom-tier">
            <Heading className="h2">{tierLabel(tier)}</Heading>
            {entries.map((entry) => (
              <DomainRow
                key={entry.domainType}
                projectId={projectId}
                entry={entry}
                draft={
                  draft.entries[entry.domainType] ?? {
                    enabled: false,
                    toolId: null,
                    config: {},
                  }
                }
                saved={byType.get(entry.domainType)}
                canEdit={canTry}
                errors={fieldErrors[entry.domainType] ?? {}}
                onEnabled={(on) =>
                  setDraft(setEnabled(draft, entry.domainType, on))
                }
                onTool={(toolId) => setDraft(chooseTool(draft, entry, toolId))}
                onConfig={(config) =>
                  setDraft(setConfig(draft, entry.domainType, config))
                }
              />
            ))}
          </div>
        ),
      )}

      {validation.data !== undefined && dirty && (
        <ValidationPanel
          validation={validation.data.validation}
          nameOf={nameOf}
          canEdit={canTry}
          onEnable={(domainType, toolId) =>
            setDraft(enableSuggested(draft, catalog, domainType, toolId))
          }
          onChoose={(cap, key) => setDraft(choosePreference(draft, cap, key))}
        />
      )}
      {save.isError &&
        !(isApiError(save.error) && save.error.code === "OPTIMISTIC_LOCK") && (
          <p role="alert" className="field-error">
            {messageOf(save.error)}
          </p>
        )}
      {canSave && (
        <div className="form-actions dom-actions">
          <button
            type="button"
            className="btn"
            disabled={!dirty || save.isPending}
            onClick={discard}
          >
            {m.discard}
          </button>
          <button
            type="button"
            className="btn pri"
            disabled={!dirty || save.isPending}
            onClick={submit}
          >
            {save.isPending ? m.saving : m.save}
          </button>
        </div>
      )}
      {confirming && (
        <ConfirmDialog
          title={m.confirmTitle}
          description={m.confirmDescription}
          confirmLabel={m.confirm}
          danger={changes.some((c) => c.kind !== "config")}
          busy={save.isPending}
          onConfirm={() => save.mutate()}
          onClose={() => setConfirming(false)}
        >
          <ul className="plan-list" aria-label={m.changes}>
            {changes.map((c) => (
              <li key={c.domainType}>{describeChange(c, catalog)}</li>
            ))}
          </ul>
        </ConfirmDialog>
      )}
    </section>
  );
}
