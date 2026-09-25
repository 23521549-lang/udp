import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  FlagDetailWire,
  PublicEnvironmentWire,
  RulesResponseWire,
} from "@udp/shared-types/wire";
import { useState } from "react";
import { Dialog } from "../../components/Dialog";
import { toast } from "../../components/Toast";
import { messageOf } from "../../lib/errors";
import { isApiError } from "../../lib/http";
import { qk, qkPrefix } from "../../lib/query-keys";
import { useProjectContext } from "../project/ProjectLayout";
import { can } from "../project/roles";
import { flagApi } from "./flag-api";
import { planPromotion, type DiffKind } from "./promote-model";

const KIND_LABEL: Record<DiffKind, string> = {
  same: "Giữ nguyên",
  changed: "Đổi",
  added: "Thêm",
  removed: "Bỏ",
};

const TYPE_LABEL: Record<string, string> = {
  ALL: "Mọi người",
  USER_BASED: "Người dùng cụ thể",
  ATTRIBUTE_BASED: "Thuộc tính",
  SEGMENT: "Segment",
};

/**
 * Sao chép rule của env đang xem sang một env khác (§10.12). Diff hiện TRƯỚC khi áp; áp
 * gửi `lastKnownUpdatedAt` của env ĐÍCH đọc lúc mở hộp, nên ai đó sửa đích trong lúc
 * này thì server trả 409 và không gì bị ghi đè.
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
      if (plan === undefined) throw new Error("chưa có kế hoạch");
      return flagApi.replaceRules(project.id, flag.id, targetId, plan.body);
    },
    onSuccess: async (data) => {
      queryClient.setQueryData(
        qk.flagRules(project.id, flag.id, targetId),
        data,
      );
      await queryClient.invalidateQueries({
        queryKey: qkPrefix.flagOf(project.id, flag.id),
      });
      await queryClient.invalidateQueries({
        queryKey: qkPrefix.flagsOf(project.id),
      });
      toast.info(`Đã sao chép rule sang ${target?.name ?? ""}`);
      onClose();
    },
    onError: async (e) => {
      // Env đích đã đổi từ lúc đọc: nạp lại để diff nói đúng hiện trạng
      if (isApiError(e) && e.status === 409) {
        await targetRules.refetch();
      }
    },
  });

  const needsKey = target?.isProduction === true;
  const ready =
    plan !== undefined &&
    plan.changes > 0 &&
    !apply.isPending &&
    (!needsKey || typed.trim() === flag.key);

  return (
    <Dialog
      title={`Sao chép rule từ ${source.name}`}
      description="Chỉ rule được chép. Bật/tắt và variant mặc định giữ nguyên ở env đích."
      onClose={onClose}
      wide
      footer={
        <>
          <button type="button" className="btn" data-close onClick={onClose}>
            Huỷ
          </button>
          <button
            type="button"
            className={needsKey ? "btn danger-fill" : "btn pri"}
            disabled={!ready}
            onClick={() => apply.mutate()}
          >
            {apply.isPending ? "Đang áp..." : "Áp dụng"}
          </button>
        </>
      }
    >
      {targets.length === 0 ? (
        <p className="c3">Bạn không có quyền sửa env nào khác.</p>
      ) : (
        <div className="f">
          <label htmlFor="promote-target">Sang environment</label>
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
        <p className="c3">Đang đọc rule ở env đích...</p>
      )}
      {plan !== undefined && (
        <>
          {plan.changes === 0 ? (
            <p className="c3">
              Rule ở {target?.name} đã giống hệt, không có gì để chép.
            </p>
          ) : (
            <div className="table-wrap">
              <table className="matrix" aria-label="Thay đổi sẽ áp">
                <thead>
                  <tr>
                    <th scope="col">Thay đổi</th>
                    <th scope="col">Rule</th>
                    <th scope="col">Nhóm người dùng ở đích</th>
                  </tr>
                </thead>
                <tbody>
                  {plan.diff.map((d, i) => (
                    <tr key={`${d.kind}-${String(i)}`} data-kind={d.kind}>
                      <th scope="row">{KIND_LABEL[d.kind]}</th>
                      <td style={{ textAlign: "left" }}>
                        {TYPE_LABEL[d.ruleType] ?? d.ruleType}
                        {d.description === null ? "" : `: ${d.description}`}
                      </td>
                      <td>
                        {d.keptId !== undefined
                          ? "giữ nguyên"
                          : d.kind === "added"
                            ? "nhóm mới"
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
            Gõ <span className="mono">{flag.key}</span> để áp ở production
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
            ? `Rule ở ${target?.name ?? "env đích"} vừa được người khác sửa. Đã tải lại, hãy xem lại diff rồi áp.`
            : messageOf(apply.error)}
        </p>
      )}
    </Dialog>
  );
}
