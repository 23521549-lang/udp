import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  DomainCatalogEntryWire,
  ProjectDomainsResponseWire,
  ProjectRoleWire,
} from "@udp/shared-types/wire";
import { useEffect, useMemo, useState } from "react";
import { ErrorState, Loading } from "../../components/States";
import { toast } from "../../components/Toast";
import { fieldErrorsOf, messageOf } from "../../lib/errors";
import { isApiError } from "../../lib/http";
import { qk } from "../../lib/query-keys";
import { can } from "../project/roles";
import { domainApi } from "./domain-api";
import {
  chooseTool,
  choosePreference,
  draftFrom,
  enableSuggested,
  sameTarget,
  setConfig,
  setEnabled,
  targetOf,
  type DomainDraft,
} from "./domain-model";
import { TIER_LABEL, toolNamer } from "./domain-labels";
import { DomainRow } from "./DomainRow";
import { ValidationPanel } from "./ValidationPanel";

/**
 * Cấu hình domain của project (§10.7, §10.12; Plan #27) — một thành phần cho trang Domain và
 * bước 3 của wizard. Quyền theo QĐ-7: VIEWER xem, DEVELOPER thử và kiểm, MAINTAINER lưu.
 */
export function DomainPanel({
  projectId,
  role,
  onSaved,
}: {
  projectId: string;
  role: ProjectRoleWire;
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
  if (catalog.isPending || saved.isPending) return <Loading />;
  if (catalog.isError) return <ErrorState error={catalog.error} />;
  if (saved.isError) return <ErrorState error={saved.error} />;
  return (
    <DomainEditor
      // Mỗi lần lưu (hay tải lại sau xung đột) dựng lại bản nháp từ bản mới nhất
      key={saved.data.domainSetVersion}
      projectId={projectId}
      catalog={catalog.data.domains}
      saved={saved.data}
      canTry={can(role, "DEVELOPER")}
      canSave={can(role, "MAINTAINER")}
      {...(onSaved === undefined ? {} : { onSaved })}
    />
  );
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
  onSaved,
}: {
  projectId: string;
  catalog: readonly DomainCatalogEntryWire[];
  saved: ProjectDomainsResponseWire;
  canTry: boolean;
  canSave: boolean;
  onSaved?: () => void;
}) {
  const queryClient = useQueryClient();
  const initial = useMemo(() => draftFrom(catalog, saved), [catalog, saved]);
  const [draft, setDraft] = useState(initial);
  const dirty = !sameTarget(draft, initial);
  const nameOf = useMemo(() => toolNamer(catalog), [catalog]);
  const validation = useLiveValidation(projectId, draft, canTry && dirty);

  const save = useMutation({
    mutationFn: () =>
      domainApi.put(projectId, {
        ...targetOf(draft),
        lastKnownDomainSetVersion: saved.domainSetVersion,
      }),
    onSuccess: (data) => {
      queryClient.setQueryData(qk.domains(projectId), data);
      toast.info("Đã lưu cấu hình domain");
      onSaved?.();
    },
    onError: async (error) => {
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

  return (
    <section aria-label="Cấu hình domain">
      {tiers.map(({ tier, entries }) =>
        entries.length === 0 ? null : (
          <div key={tier}>
            <h3 className="h2">{TIER_LABEL[tier]}</h3>
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
        <div className="form-actions">
          <button
            type="button"
            className="btn"
            disabled={!dirty || save.isPending}
            onClick={() => setDraft(initial)}
          >
            Bỏ thay đổi
          </button>
          <button
            type="button"
            className="btn pri"
            disabled={!dirty || save.isPending}
            onClick={() => save.mutate()}
          >
            {save.isPending ? "Đang lưu..." : "Lưu cấu hình domain"}
          </button>
        </div>
      )}
    </section>
  );
}
