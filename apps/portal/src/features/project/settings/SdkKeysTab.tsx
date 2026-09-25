import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { SdkKeyWire } from "@udp/shared-types/wire";
import { KeyRound } from "lucide-react";
import { useState } from "react";
import { CodeBlock } from "../../../components/CodeBlock";
import { ConfirmDialog } from "../../../components/ConfirmDialog";
import { Dialog } from "../../../components/Dialog";
import { Icon } from "../../../components/Icon";
import { Empty, ErrorState, Loading } from "../../../components/States";
import { toast } from "../../../components/Toast";
import { messageOf } from "../../../lib/errors";
import { relativeTime } from "../../../lib/format";
import { qk } from "../../../lib/query-keys";
import { useProjectContext } from "../ProjectLayout";
import { projectApi } from "../project-api";
import { can } from "../roles";

const KEY_TYPE_HINT = {
  SERVER:
    "Đánh giá tại chỗ: nhận toàn bộ rule. Chỉ dùng ở backend, không bao giờ nhúng vào trình duyệt.",
  CLIENT:
    "Gửi context lên và nhận kết quả (OFREP): rule không bao giờ rời máy chủ. Dùng được ở trình duyệt.",
} as const;

export function SdkKeysTab() {
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
      toast.info("Đã thu hồi key");
      await queryClient.invalidateQueries({
        queryKey: qk.sdkKeys(project.id, env.id),
      });
    },
  });
  const isOwner = can(project.myRole, "OWNER");
  const weekAgo = Date.now() - 7 * 24 * 3600 * 1000;

  return (
    <section aria-label={`SDK key ở ${env.name}`}>
      <div className="sect">
        <h3>SDK key ở {env.name}</h3>
        {isOwner && (
          <div className="r">
            <button
              type="button"
              className="btn pri"
              onClick={() => setCreating(true)}
            >
              <Icon of={KeyRound} />
              Tạo key
            </button>
          </div>
        )}
      </div>
      <dl className="props">
        <dt>SERVER</dt>
        <dd className="c2">{KEY_TYPE_HINT.SERVER}</dd>
        <dt>CLIENT</dt>
        <dd className="c2">{KEY_TYPE_HINT.CLIENT}</dd>
      </dl>
      {keys.isPending ? (
        <Loading />
      ) : keys.isError ? (
        <ErrorState error={keys.error} onRetry={() => void keys.refetch()} />
      ) : keys.data.keys.length === 0 ? (
        <Empty title="Chưa có key nào ở environment này" />
      ) : (
        <div className="lst">
          {keys.data.keys.map((k) => (
            <div key={k.id} className="it">
              <span className="mono">{k.maskedKey}</span>
              <span className="chip soft">{k.keyType}</span>
              <span className="c3">{k.label ?? ""}</span>
              <span className="c3" style={{ marginLeft: "auto" }}>
                {k.status === "revoked"
                  ? `Đã thu hồi ${k.revokedAt === null ? "" : relativeTime(k.revokedAt)}`
                  : k.lastUsedAt === null
                    ? new Date(k.createdAt).getTime() < weekAgo
                      ? "Chưa dùng sau 7 ngày"
                      : "Chưa dùng"
                    : `Dùng ${relativeTime(k.lastUsedAt)}`}
              </span>
              {isOwner && k.status === "active" && (
                <button
                  type="button"
                  className="btn danger"
                  onClick={() => setRevoking(k)}
                >
                  Thu hồi
                </button>
              )}
            </div>
          ))}
        </div>
      )}
      {creating && <CreateKeyDialog onClose={() => setCreating(false)} />}
      {revoking !== null && (
        <ConfirmDialog
          title="Thu hồi key này?"
          description={`Ứng dụng đang dùng ${revoking.maskedKey} sẽ mất quyền đọc flag ngay.`}
          confirmLabel="Thu hồi"
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
        title="Key đã tạo"
        description="Sao chép ngay: đây là lần duy nhất key hiện đầy đủ, không xem lại được."
        onClose={onClose}
        footer={
          <button type="button" className="btn pri" onClick={onClose}>
            Đã lưu key
          </button>
        }
      >
        <CodeBlock code={secret} label="SDK key" copyLabel="Sao chép key" />
      </Dialog>
    );
  }

  return (
    <Dialog
      title={`Tạo SDK key ở ${env.name}`}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" data-close onClick={onClose}>
            Huỷ
          </button>
          <button
            type="button"
            className="btn pri"
            disabled={create.isPending}
            onClick={() => create.mutate()}
          >
            {create.isPending ? "Đang tạo..." : "Tạo key"}
          </button>
        </>
      }
    >
      <div className="opts" role="group" aria-label="Loại key">
        {(["SERVER", "CLIENT"] as const).map((t) => (
          <button
            key={t}
            type="button"
            aria-pressed={keyType === t}
            onClick={() => setKeyType(t)}
          >
            <b>{t}</b>
            {KEY_TYPE_HINT[t]}
          </button>
        ))}
      </div>
      <div className="f">
        <label htmlFor="key-label">Nhãn (tuỳ chọn)</label>
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
