import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { planPromotion } from "@udp/shared-types/promote";
import type {
  FlagDetailWire,
  PublicEnvironmentWire,
  RulesResponseWire,
} from "@udp/shared-types/wire";
import { useState } from "react";
import { Dialog } from "../../components/Dialog";
import { toast } from "../../components/Toast";
import { useMessages } from "../../i18n";
import { messageOf } from "../../lib/errors";
import { isApiError } from "../../lib/http";
import { qk, qkPrefix } from "../../lib/query-keys";
import { useProjectContext } from "../project/ProjectLayout";
import { can } from "../project/roles";
import { flagApi } from "./flag-api";
import { flagMessages } from "./flag.messages";
import { rulesMessages } from "./rules.messages";

/**
 * Sao chép rule của env đang xem sang một env khác (§10.12). Diff hiện TRƯỚC khi áp, dựng bằng
 * `planPromotion` — CÙNG hàm Service 1 chạy khi nhận `POST …/promote` [Plan #44]. Lời gọi mang mốc
 * của rule NGUỒN đã xem và mốc của env ĐÍCH đọc lúc mở hộp: ai sửa một trong hai trong lúc này thì
 * server trả 409 và không gì bị ghi đè.
 */
export function PromoteDialog({
  flag,
  source,
  sourceRules,
  onClose,
}: {
  flag: FlagDetailWire;
  source: PublicEnvironmentWire;
  sourceRules: RulesResponseWire;
  onClose: () => void;
}) {
  const all = useMessages(flagMessages);
  const m = all.promote;
  const ruleType = useMessages(rulesMessages).ruleType;
  const { project, envs } = useProjectContext();
  const queryClient = useQueryClient();
  const targets = [...envs]
    .filter((e) => e.id !== source.id)
    .filter((e) =>
      can(project.myRole, e.isProduction ? "MAINTAINER" : "DEVELOPER"),
    )
    .sort((a, b) => a.rank - b.rank);
  const [targetId, setTargetId] = useState(
    targets.find((e) => e.rank > source.rank)?.id ?? targets[0]?.id ?? "",
  );
  const [typed, setTyped] = useState("");
  const target = targets.find((e) => e.id === targetId);
  const needsKey = target?.isProduction === true;

  const targetRules = useQuery({
    queryKey: qk.flagRules(project.id, flag.id, targetId),
    queryFn: () => flagApi.rules(project.id, flag.id, targetId),
    enabled: targetId !== "",
    staleTime: 0,
  });
  const plan =
    targetRules.data === undefined
      ? undefined
      : planPromotion(
          sourceRules.rules,
          targetRules.data.rules,
          targetRules.data.updatedAt,
        );

  const apply = useMutation({
    mutationFn: () => {
      if (targetRules.data === undefined) throw new Error(m.noPlan);
      return flagApi.promote(project.id, flag.id, {
        fromEnvId: source.id,
        toEnvId: targetId,
        sourceUpdatedAt: sourceRules.updatedAt,
        lastKnownUpdatedAt: targetRules.data.updatedAt,
        ...(needsKey ? { confirmFlagKey: typed.trim() } : {}),
      });
    },
    onSuccess: async ({ updatedAt, rules }) => {
      queryClient.setQueryData(qk.flagRules(project.id, flag.id, targetId), {
        updatedAt,
        rules,
      });
      await queryClient.invalidateQueries({
        queryKey: qkPrefix.flagOf(project.id, flag.id),
      });
      await queryClient.invalidateQueries({
        queryKey: qkPrefix.flagsOf(project.id),
      });
      toast.info(m.copied(target?.name ?? ""));
      onClose();
    },
    onError: async (e) => {
      // Nguồn hoặc đích đã đổi từ lúc đọc: nạp lại cả hai để diff nói đúng hiện trạng
      if (isApiError(e) && e.status === 409) {
        await queryClient.invalidateQueries({
          queryKey: qk.flagRules(project.id, flag.id, source.id),
        });
        await targetRules.refetch();
      }
    },
  });
  const ready =
    plan !== undefined &&
    plan.changes > 0 &&
    !apply.isPending &&
    (!needsKey || typed.trim() === flag.key);

  return (
    <Dialog
      title={m.title(source.name)}
      description={m.description}
      onClose={onClose}
      wide
      footer={
        <>
          <button type="button" className="btn" data-close onClick={onClose}>
            {all.cancel}
          </button>
          <button
            type="button"
            className={needsKey ? "btn danger-fill" : "btn pri"}
            disabled={!ready}
            onClick={() => apply.mutate()}
          >
            {apply.isPending ? m.applying : m.apply}
          </button>
        </>
      }
    >
      {targets.length === 0 ? (
        <p className="c3">{m.noTargets}</p>
      ) : (
        <div className="f">
          <label htmlFor="promote-target">{m.target}</label>
          <select
            id="promote-target"
            className="sel"
            value={targetId}
            onChange={(e) => {
              setTargetId(e.target.value);
              setTyped("");
              apply.reset();
            }}
          >
            {targets.map((e) => (
              <option key={e.id} value={e.id}>
                {e.name}
              </option>
            ))}
          </select>
        </div>
      )}
      {targetRules.isPending && targetId !== "" && (
        <p className="c3">{m.reading}</p>
      )}
      {plan !== undefined && (
        <>
          {plan.changes === 0 ? (
            <p className="c3">{m.identical(target?.name ?? "")}</p>
          ) : (
            <div className="table-wrap">
              <table className="matrix" aria-label={m.table}>
                <thead>
                  <tr>
                    <th scope="col">{m.colChange}</th>
                    <th scope="col">{m.colRule}</th>
                    <th scope="col">{m.colGroup}</th>
                  </tr>
                </thead>
                <tbody>
                  {plan.diff.map((d, i) => (
                    <tr key={`${d.kind}-${String(i)}`} data-kind={d.kind}>
                      <th scope="row">{m.kind[d.kind]}</th>
                      <td style={{ textAlign: "left" }}>
                        {ruleType[d.ruleType]}
                        {d.description === null ? "" : `: ${d.description}`}
                      </td>
                      <td>
                        {d.keptId !== undefined
                          ? m.kept
                          : d.kind === "added"
                            ? m.newGroup
                            : "–"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
      {needsKey && plan !== undefined && plan.changes > 0 && (
        <div className="f">
          <label htmlFor="promote-key">
            {m.typeToApply(<span className="mono">{flag.key}</span>)}
          </label>
          <input
            id="promote-key"
            className="inp"
            autoComplete="off"
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
          />
        </div>
      )}
      {apply.isError && (
        <p role="alert" className="field-error">
          {isApiError(apply.error) && apply.error.status === 409
            ? m.conflict(source.name, target?.name)
            : messageOf(apply.error)}
        </p>
      )}
    </Dialog>
  );
}
