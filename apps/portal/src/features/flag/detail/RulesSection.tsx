import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  FlagDetailWire,
  PublicEnvironmentWire,
  RulesResponseWire,
} from "@udp/shared-types/wire";
import { CopyPlus, Plus } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { ConfirmDialog } from "../../../components/ConfirmDialog";
import { Icon } from "../../../components/Icon";
import { ErrorState, Loading } from "../../../components/States";
import { toast } from "../../../components/Toast";
import { UnsavedGuard } from "../../../components/UnsavedGuard";
import { useMessages } from "../../../i18n";
import { shortcut } from "../../../lib/keys";
import { messageOf } from "../../../lib/errors";
import { isApiError } from "../../../lib/http";
import { qk, qkPrefix } from "../../../lib/query-keys";
import { flagApi } from "../flag-api";
import { useProjectContext } from "../../project/ProjectLayout";
import { can } from "../../project/roles";
import { PromoteDialog } from "../PromoteDialog";
import { RuleCard } from "../RuleEditor";
import {
  changeCount,
  draftsFromWire,
  move,
  newRule,
  ruleProblems,
  toReplaceBody,
  type RuleDraft,
} from "../rules-model";
import { detailMessages } from "./detail.messages";

export function RulesSection({
  flag,
  env,
  canEdit,
}: {
  flag: FlagDetailWire;
  env: PublicEnvironmentWire;
  canEdit: boolean;
}) {
  const m = useMessages(detailMessages).rules;
  const { project } = useProjectContext();
  const rules = useQuery({
    queryKey: qk.flagRules(project.id, flag.id, env.id),
    queryFn: () => flagApi.rules(project.id, flag.id, env.id),
    staleTime: 10_000,
  });

  if (rules.isPending) return <Loading label={m.loading} />;
  if (rules.isError) {
    return (
      <ErrorState error={rules.error} onRetry={() => void rules.refetch()} />
    );
  }
  /*
   * `key` theo env và mốc updatedAt: server đổi ⇒ trình sửa dựng lại từ bản mới. Đổi env khi còn nháp
   * KHÔNG lặng lẽ xoá nháp: đổi env là một điều hướng, và `UnsavedGuard` của trình sửa hỏi trước.
   */
  return (
    <RulesEditor
      key={`${env.id}:${rules.data.updatedAt}`}
      flag={flag}
      env={env}
      server={rules.data}
      canEdit={canEdit}
    />
  );
}

function RulesEditor({
  flag,
  env,
  server,
  canEdit,
}: {
  flag: FlagDetailWire;
  env: PublicEnvironmentWire;
  server: RulesResponseWire;
  canEdit: boolean;
}) {
  const all = useMessages(detailMessages);
  const m = all.rules;
  const { project } = useProjectContext();
  const queryClient = useQueryClient();
  const [drafts, setDrafts] = useState<RuleDraft[]>(() =>
    draftsFromWire(server.rules),
  );
  const [confirmProd, setConfirmProd] = useState(false);
  const [promoting, setPromoting] = useState(false);

  const changes = changeCount(drafts, server.rules);
  // `m` trong danh sách phụ thuộc: đổi ngôn ngữ thì câu lỗi của rule dựng lại theo ngôn ngữ mới
  const problems = useMemo(
    () => ruleProblems(drafts, flag.variants),
    [drafts, flag.variants, m],
  );

  const save = useMutation({
    mutationFn: () =>
      flagApi.replaceRules(
        project.id,
        flag.id,
        env.id,
        toReplaceBody(drafts, server.updatedAt),
      ),
    onSuccess: async (data) => {
      setConfirmProd(false);
      queryClient.setQueryData(qk.flagRules(project.id, flag.id, env.id), data);
      await queryClient.invalidateQueries({
        queryKey: qkPrefix.flagOf(project.id, flag.id),
      });
      await queryClient.invalidateQueries({
        queryKey: qkPrefix.flagsOf(project.id),
      });
      toast.info(m.savedIn(env.name));
    },
    onError: async (e) => {
      setConfirmProd(false);
      toast.error(messageOf(e));
      // 409 OPTIMISTIC_LOCK: tải bản mới; trình sửa dựng lại từ nó (§10.8)
      if (isApiError(e) && e.status === 409) {
        await queryClient.invalidateQueries({
          queryKey: qk.flagRules(project.id, flag.id, env.id),
        });
      }
    },
  });

  const submit = useCallback(() => {
    if (changes === 0 || problems.size > 0 || save.isPending) return;
    if (env.isProduction) setConfirmProd(true);
    else save.mutate();
  }, [changes, problems.size, save, env.isProduction]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        submit();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [submit]);

  const discard = () => {
    const before = drafts;
    setDrafts(draftsFromWire(server.rules));
    toast.info(m.discarded(changes), () => setDrafts(before));
  };

  return (
    <section aria-label={m.section}>
      <UnsavedGuard dirty={changes > 0} what={m.unsaved(changes, env.name)} />
      <div className="sect">
        <h3>{m.rulesIn(env.name)}</h3>
        <span className="c3">{m.topDown}</span>
        <div className="r">
          {can(project.myRole, "DEVELOPER") && (
            <button
              type="button"
              className="btn"
              disabled={changes > 0}
              title={changes > 0 ? m.saveFirst : undefined}
              onClick={() => setPromoting(true)}
            >
              <Icon of={CopyPlus} />
              {m.copyTo}
            </button>
          )}
          {canEdit && (
            <button
              type="button"
              className="btn"
              onClick={() => setDrafts([...drafts, newRule(flag.variants)])}
            >
              <Icon of={Plus} />
              {m.addRule}
            </button>
          )}
        </div>
      </div>
      {promoting && (
        <PromoteDialog
          flag={flag}
          source={env}
          sourceRules={server}
          onClose={() => setPromoting(false)}
        />
      )}
      {drafts.length === 0 && <p className="c3">{m.none}</p>}
      {drafts.map((rule, i) => (
        <RuleCard
          key={rule.localKey}
          index={i}
          total={drafts.length}
          rule={rule}
          variants={flag.variants}
          projectId={project.id}
          problem={problems.get(i)}
          readOnly={!canEdit}
          onChange={(next) =>
            setDrafts(drafts.map((r, j) => (j === i ? next : r)))
          }
          onMove={(delta) => setDrafts(move(drafts, i, delta))}
          onRemove={() => setDrafts(drafts.filter((_, j) => j !== i))}
        />
      ))}
      <div
        className={changes > 0 ? "savebar on" : "savebar"}
        aria-hidden={changes === 0}
      >
        <span>{m.pending(changes, env.name)}</span>
        <button
          type="button"
          className="btn"
          tabIndex={changes === 0 ? -1 : 0}
          onClick={discard}
        >
          {m.discard}
        </button>
        <button
          type="button"
          className="btn pri"
          tabIndex={changes === 0 ? -1 : 0}
          disabled={problems.size > 0 || save.isPending}
          onClick={submit}
        >
          {save.isPending ? all.saving : all.save} <kbd>{shortcut("S")}</kbd>
        </button>
      </div>
      {confirmProd && (
        <ConfirmDialog
          title={m.confirmTitle}
          description={m.confirmDescription(changes)}
          confirmLabel={all.save}
          busy={save.isPending}
          onConfirm={() => save.mutate()}
          onClose={() => setConfirmProd(false)}
        />
      )}
    </section>
  );
}
