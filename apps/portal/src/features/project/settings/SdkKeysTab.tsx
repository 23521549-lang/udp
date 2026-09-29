import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { SdkKeyWire } from "@udp/shared-types/wire";
import { KeyRound } from "lucide-react";
import { Fragment, useState } from "react";
import { CodeBlock } from "../../../components/CodeBlock";
import { ConfirmDialog } from "../../../components/ConfirmDialog";
import { Dialog } from "../../../components/Dialog";
import { Icon } from "../../../components/Icon";
import { Empty, ErrorState, Loading } from "../../../components/States";
import { toast } from "../../../components/Toast";
import { useMessages } from "../../../i18n";
import { messageOf } from "../../../lib/errors";
import { relativeTime } from "../../../lib/format";
import { qk } from "../../../lib/query-keys";
import { useProjectContext } from "../ProjectLayout";
import { projectApi } from "../project-api";
import { can } from "../roles";
import { settingsMessages } from "./settings.messages";

const KEY_TYPES = ["SERVER", "CLIENT"] as const;

export function SdkKeysTab() {
  const m = useMessages(settingsMessages).keys;
  const { project, env } = useProjectContext();
  const queryClient = useQueryClient();
  const [creating, setCreating] = useState(false);
  const [revoking, setRevoking] = useState<SdkKeyWire | null>(null);
  const keys = useQuery({
    queryKey: qk.sdkKeys(project.id, env.id),
    queryFn: () => projectApi.sdkKeys(project.id, env.id),
  });
  const revoke = useMutation({
    mutationFn: (keyId: string) =>
      projectApi.revokeSdkKey(project.id, env.id, keyId),
    onSuccess: async () => {
      setRevoking(null);
      toast.info(m.revoked);
      await queryClient.invalidateQueries({
        queryKey: qk.sdkKeys(project.id, env.id),
      });
    },
  });
  const isOwner = can(project.myRole, "OWNER");
  const weekAgo = Date.now() - 7 * 24 * 3600 * 1000;

  return (
    <section aria-label={m.inEnv(env.name)}>
      <div className="sect">
        <h2>{m.inEnv(env.name)}</h2>
        {isOwner && (
          <div className="r">
            <button
              type="button"
              className="btn pri"
              onClick={() => setCreating(true)}
            >
              <Icon of={KeyRound} />
              {m.create}
            </button>
          </div>
        )}
      </div>
      <dl className="props">
        {KEY_TYPES.map((t) => (
          <Fragment key={t}>
            <dt>{t}</dt>
            <dd className="c2">{m.typeHint[t]}</dd>
          </Fragment>
        ))}
      </dl>
      {keys.isPending ? (
        <Loading />
      ) : keys.isError ? (
        <ErrorState error={keys.error} onRetry={() => void keys.refetch()} />
      ) : keys.data.keys.length === 0 ? (
        <Empty title={m.empty} />
      ) : (
        <div className="lst">
          {keys.data.keys.map((k) => (
            <div key={k.id} className="it">
              <span className="mono" translate="no">
                {k.maskedKey}
              </span>
              <span className="chip soft">{k.keyType}</span>
              <span className="c3">{k.label ?? ""}</span>
              <span className="c3" style={{ marginLeft: "auto" }}>
                {k.status === "revoked"
                  ? m.revokedAt(
                      k.revokedAt === null ? "" : relativeTime(k.revokedAt),
                    )
                  : k.lastUsedAt === null
                    ? new Date(k.createdAt).getTime() < weekAgo
                      ? m.unusedWeek
                      : m.unused
                    : m.usedAt(relativeTime(k.lastUsedAt))}
              </span>
              {isOwner && k.status === "active" && (
                <button
                  type="button"
                  className="btn danger"
                  onClick={() => setRevoking(k)}
                >
                  {m.revoke}
                </button>
              )}
            </div>
          ))}
        </div>
      )}
      {creating && <CreateKeyDialog onClose={() => setCreating(false)} />}
      {revoking !== null && (
        <ConfirmDialog
          title={m.revokeTitle}
          description={m.revokeBody(revoking.maskedKey)}
          confirmLabel={m.revoke}
          danger
          busy={revoke.isPending}
          error={revoke.isError ? messageOf(revoke.error) : undefined}
          onConfirm={() => revoke.mutate(revoking.id)}
          onClose={() => {
            setRevoking(null);
            revoke.reset();
          }}
        />
      )}
    </section>
  );
}

/**
 * Key mới hiện plaintext ĐÚNG MỘT LẦN, trong hộp có nút sao chép và lời cảnh báo không xem
 * lại được (§10.12). Plaintext chỉ sống trong state của hộp này — không vào cache của
 * React Query, không vào URL, không vào storage.
 */
function CreateKeyDialog({ onClose }: { onClose: () => void }) {
  const t = useMessages(settingsMessages);
  const m = t.keys;
  const { project, env } = useProjectContext();
  const queryClient = useQueryClient();
  const [keyType, setKeyType] = useState<"SERVER" | "CLIENT">("SERVER");
  const [label, setLabel] = useState("");
  const [secret, setSecret] = useState<string | null>(null);

  const create = useMutation({
    mutationFn: () =>
      projectApi.createSdkKey(project.id, env.id, {
        keyType,
        label: label.trim() === "" ? null : label.trim(),
      }),
    onSuccess: async (data) => {
      setSecret(data.secretKey);
      await queryClient.invalidateQueries({
        queryKey: qk.sdkKeys(project.id, env.id),
      });
    },
  });

  if (secret !== null) {
    return (
      <Dialog
        title={m.createdTitle}
        description={m.createdBody}
        onClose={onClose}
        footer={
          <button type="button" className="btn pri" onClick={onClose}>
            {m.savedIt}
          </button>
        }
      >
        <CodeBlock code={secret} label={m.sdkKey} copyLabel={m.copy} />
      </Dialog>
    );
  }

  return (
    <Dialog
      title={m.createTitle(env.name)}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" data-close onClick={onClose}>
            {t.cancel}
          </button>
          <button
            type="button"
            className="btn pri"
            disabled={create.isPending}
            onClick={() => create.mutate()}
          >
            {create.isPending ? t.creating : m.create}
          </button>
        </>
      }
    >
      <div className="opts" role="group" aria-label={m.type}>
        {KEY_TYPES.map((type) => (
          <button
            key={type}
            type="button"
            aria-pressed={keyType === type}
            onClick={() => setKeyType(type)}
          >
            <b>{type}</b>
            {m.typeHint[type]}
          </button>
        ))}
      </div>
      <div className="f">
        <label htmlFor="key-label">{m.label}</label>
        <input
          id="key-label"
          className="inp"
          value={label}
          onChange={(e) => setLabel(e.target.value)}
        />
      </div>
      {create.isError && (
        <p className="field-error">{messageOf(create.error)}</p>
      )}
    </Dialog>
  );
}
