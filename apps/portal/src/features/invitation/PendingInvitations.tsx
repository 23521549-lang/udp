import { useMessages } from "../../i18n";
import { formatDateTime, relativeTime } from "../../lib/format";
import { invitationMessages } from "./invitation.messages";

/** Phần chung của lời mời đang chờ vào project và vào nhóm */
interface Pending {
  id: string;
  email: string;
  invitedBy: { name: string };
  expiresAt: string;
}

/**
 * [Plan #55] Lời mời đang chờ của một project hay một nhóm. Không bao giờ có đường dẫn ở đây — máy chủ không còn
 * giữ token; "Tạo lại đường dẫn" tạo lời mời mới cùng email và vai, lời cũ hết dùng được. Generic theo bản ghi để
 * chỗ gọi nhận lại ĐÚNG lời mời (và vai của nó) khi bấm, không phải tra lại.
 */
export function PendingInvitations<T extends Pending>({
  items,
  roleOf,
  busy,
  onReissue,
  onRevoke,
}: {
  items: readonly T[];
  /** Chữ của vai được mời */
  roleOf: (item: T) => string;
  busy: boolean;
  onReissue: (item: T) => void;
  onRevoke: (item: T) => void;
}) {
  const m = useMessages(invitationMessages).pending;
  if (items.length === 0) return null;
  return (
    <>
      <h2 className="h2">{m.title}</h2>
      <div className="lst" role="list" aria-label={m.label}>
        {items.map((x) => {
          const expired = Date.parse(x.expiresAt) <= Date.now();
          return (
            <div key={x.id} className="it" role="listitem">
              <b className="lst-name" translate="no">
                {x.email}
              </b>
              <span className="chip soft">{roleOf(x)}</span>
              <span className="c3" title={formatDateTime(x.expiresAt)}>
                {expired
                  ? m.expired
                  : m.byAndExpiry(x.invitedBy.name, relativeTime(x.expiresAt))}
              </span>
              <span className="lst-end">
                <button
                  type="button"
                  className="btn"
                  aria-label={m.reissueOf(x.email)}
                  disabled={busy}
                  onClick={() => onReissue(x)}
                >
                  {m.reissue}
                </button>
                <button
                  type="button"
                  className="btn danger"
                  aria-label={m.revokeOf(x.email)}
                  disabled={busy}
                  onClick={() => onRevoke(x)}
                >
                  {m.revoke}
                </button>
              </span>
            </div>
          );
        })}
      </div>
    </>
  );
}
