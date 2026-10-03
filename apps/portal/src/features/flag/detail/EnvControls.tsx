import { useMutation, useQueryClient } from "@tanstack/react-query";
import type {
  FlagDetailWire,
  PublicEnvironmentWire,
} from "@udp/shared-types/wire";
import { useCallback, useState } from "react";
import { ConfirmDialog } from "../../../components/ConfirmDialog";
import { InfoTip } from "../../../components/InfoTip";
import { Switch } from "../../../components/Switch";
import { toast } from "../../../components/Toast";
import { useMessages } from "../../../i18n";
import { messageOf } from "../../../lib/errors";
import { qk, qkPrefix } from "../../../lib/query-keys";
import { flagApi } from "../flag-api";
import { useProjectContext } from "../../project/ProjectLayout";
import { detailMessages } from "./detail.messages";

type EnvChange = { isEnabled?: boolean; defaultVariantId?: string | null };

export function EnvControls({
  flag,
  env,
  isEnabled,
  defaultVariantId,
  canEdit,
}: {
  flag: FlagDetailWire;
  env: PublicEnvironmentWire;
  isEnabled: boolean;
  defaultVariantId: string | null;
  canEdit: boolean;
}) {
  const all = useMessages(detailMessages);
  const m = all.env;
  const { project } = useProjectContext();
  const queryClient = useQueryClient();
  const [pending, setPending] = useState<EnvChange | null>(null);

  const invalidate = useCallback(async () => {
    await queryClient.invalidateQueries({
      queryKey: qkPrefix.flagOf(project.id, flag.id),
    });
    await queryClient.invalidateQueries({
      queryKey: qkPrefix.flagsOf(project.id),
    });
    await queryClient.invalidateQueries({
      queryKey: qk.flagEnvs(project.id, flag.id),
    });
  }, [queryClient, project.id, flag.id]);

  const update = useMutation({
    mutationFn: (v: { change: EnvChange; confirmFlagKey?: string }) =>
      flagApi.updateEnv(project.id, flag.id, env.id, {
        ...v.change,
        ...(v.confirmFlagKey === undefined
          ? {}
          : { confirmFlagKey: v.confirmFlagKey }),
      }),
    onSuccess: invalidate,
  });

  /**
   * Production: bật hay đổi mặc định cần gõ lại key (428 `CONFIRMATION_REQUIRED`, §8.4);
   * TẮT (kill-switch) chỉ cần một xác nhận — lúc có sự cố không ai nên phải gõ.
   * Env khác: áp ngay, kèm "Hoàn tác" 5 giây (DESIGN.md §7).
   */
  const request = (change: EnvChange) => {
    if (env.isProduction) {
      setPending(change);
      return;
    }
    const before: EnvChange =
      change.isEnabled !== undefined ? { isEnabled } : { defaultVariantId };
    update.mutate(
      { change },
      {
        onSuccess: () =>
          toast.info(m.savedIn(env.name), () =>
            update.mutate({ change: before }),
          ),
        onError: (e) => toast.error(messageOf(e)),
      },
    );
  };

  const killSwitch =
    pending?.isEnabled === false && pending.defaultVariantId === undefined;

  return (
    <div className="env-controls">
      <div className="sect">
        <h3>{m.enabledIn(env.name)}</h3>
        <InfoTip term="killSwitch" />
        <div className="r">
          <Switch
            checked={isEnabled}
            label={m.enableFlagIn(env.name)}
            disabled={!canEdit || update.isPending}
            onChange={(next) => request({ isEnabled: next })}
          />
        </div>
      </div>
      <div className="line">
        <label htmlFor="default-variant" className="c3">
          {m.defaultWhenNoMatch}
        </label>
        <select
          id="default-variant"
          className="sel"
          value={defaultVariantId ?? ""}
          disabled={!canEdit || update.isPending}
          onChange={(e) =>
            request({
              defaultVariantId: e.target.value === "" ? null : e.target.value,
            })
          }
        >
          <option value="">{m.flagDefault}</option>
          {flag.variants.map((v) => (
            <option key={v.id} value={v.id}>
              {v.key}
            </option>
          ))}
        </select>
      </div>
      {pending !== null && (
        <ConfirmDialog
          title={
            killSwitch ? m.turnOffTitle(flag.key) : m.changeTitle(flag.key)
          }
          description={killSwitch ? m.turnOffDescription : m.changeDescription}
          confirmLabel={killSwitch ? m.turnOffNow : all.apply}
          danger={killSwitch}
          {...(killSwitch ? {} : { typeToConfirm: flag.key })}
          busy={update.isPending}
          error={update.isError ? messageOf(update.error) : undefined}
          onConfirm={(typed) =>
            update.mutate(
              {
                change: pending,
                ...(typed === undefined ? {} : { confirmFlagKey: typed }),
              },
              {
                onSuccess: () => {
                  setPending(null);
                  toast.info(m.savedInProduction);
                },
              },
            )
          }
          onClose={() => {
            setPending(null);
            update.reset();
          }}
        />
      )}
    </div>
  );
}
