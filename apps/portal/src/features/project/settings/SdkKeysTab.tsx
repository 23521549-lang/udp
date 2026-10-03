import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useSearch } from "@tanstack/react-router";
import type { SdkKeyWire } from "@udp/shared-types/wire";
import { KeyRound } from "lucide-react";
import { Fragment, useState } from "react";
import { CodeBlock } from "../../../components/CodeBlock";
import { ConfirmDialog } from "../../../components/ConfirmDialog";
import { Dialog } from "../../../components/Dialog";
import { Icon } from "../../../components/Icon";
import { InfoTip } from "../../../components/InfoTip";
import { Empty, ErrorState, Loading } from "../../../components/States";
import { toast } from "../../../components/Toast";
import { useMessages } from "../../../i18n";
import { messageOf } from "../../../lib/errors";
import { relativeTime } from "../../../lib/format";
import { qk } from "../../../lib/query-keys";
import { useProjectContext } from "../ProjectLayout";
import { projectApi } from "../project-api";
import { can } from "../roles";
import { SdkQuickstart } from "./SdkQuickstart";
import { settingsMessages } from "./settings.messages";

const KEY_TYPES = ["SERVER", "CLIENT"] as const;

export function SdkKeysTab() {
  const m = useMessages(settingsMessages).keys;
  const { project, env } = useProjectContext();
  const queryClient = useQueryClient();
  const isOwner = can(project.myRole, "OWNER");
  // [Plan #58 UX-29] "Tạo SDK key" từ Ctrl K mở thẳng hộp tạo; đóng hộp thì bỏ lệnh khỏi URL (tải lại không mở lại)
  const once = useSearch({ from: "/app/projects/$projectId/settings" }).new;
  const navigate = useNavigate();
  const [creating, setCreating] = useState(once === "1" && isOwner);
  const closeCreate = (): void => {
    setCreating(false);
    if (once === undefined) return;
    void navigate({
      to: ".",
      replace: true,
      search: (prev: Record<string, unknown>) => {
        const { new: _once, ...rest } = prev;
        return rest;
      },
    });
  };
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
  const weekAgo = Date.now() - 7 * 24 * 3600 * 1000;

  return (
    <section aria-label={m.inEnv(env.name)}>
      <div className="sect">
        <h2>{m.inEnv(env.name)}</h2>
        <InfoTip term="sdkKey" />
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
            <dt>{m.typeName[t]}</dt>
            <dd className="c2">
              {m.typeHint[t]}
              {t === "CLIENT" && <InfoTip term="ofrep" />}
            </dd>
          </Fragment>
        ))}
      </dl>
      {keys.isPending ? (
        <Loading />
      ) : keys.isError ? (
        <ErrorState error={keys.error} onRetry={() => void keys.refetch()} />
      ) : keys.data.keys.length === 0 ? (
        <Empty title={m.emptyTitle(env.name)}>
          <p className="empty-why">{isOwner ? m.emptyBody : m.emptyNotOwner}</p>
          {isOwner && (
            <div className="empty-actions">
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
        </Empty>
      ) : (
        <div className="lst">
          {keys.data.keys.map((k) => (
            <div key={k.id} className="it">
              <span className="mono" translate="no">
                {k.maskedKey}
              </span>
              <span className="chip soft">{m.typeName[k.keyType]}</span>
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
      <SdkQuickstart level={2} />
      {creating && <CreateKeyDialog onClose={closeCreate} />}
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
  const [secret, setSecret] = useState<{
    key: string;
    type: SdkKeyWire["keyType"];
  } | null>(null);

  const create = useMutation({
    mutationFn: () =>
      projectApi.createSdkKey(project.id, env.id, {
        keyType,
        label: label.trim() === "" ? null : label.trim(),
      }),
    onSuccess: async (data) => {
      setSecret({ key: data.secretKey, type: data.key.keyType });
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
        wide
        footer={
          <button type="button" className="btn pri" onClick={onClose}>
            {m.savedIt}
          </button>
        }
      >
        <CodeBlock code={secret.key} label={m.sdkKey} copyLabel={m.copy} />
        {/* [Plan #58 UX-13] Có key rồi thì bước tiếp theo là dùng nó: ba bước cài SDK hợp với loại key */}
        <SdkQuickstart keyType={secret.type} level={3} />
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
            <b>{m.typeName[type]}</b>
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
