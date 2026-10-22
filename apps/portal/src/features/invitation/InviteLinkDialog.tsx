import { CodeBlock } from "../../components/CodeBlock";
import { Dialog } from "../../components/Dialog";
import { useMessages } from "../../i18n";
import { useInviteLinkOf } from "./invitation-api";
import { invitationMessages } from "./invitation.messages";

/**
 * [Plan #55] Đường dẫn mời vừa tạo — hiện MỘT lần, như SDK key: máy chủ chỉ giữ hash của token, đóng hộp này là
 * không lấy lại được (tạo lại đường dẫn thì đường dẫn cũ hết dùng được).
 */
export function InviteLinkDialog({
  email,
  token,
  onClose,
}: {
  email: string;
  token: string;
  onClose: () => void;
}) {
  const m = useMessages(invitationMessages).link;
  const link = useInviteLinkOf()(token);
  return (
    <Dialog
      title={m.title}
      description={m.body(email)}
      onClose={onClose}
      footer={
        <button type="button" className="btn pri" onClick={onClose}>
          {m.done}
        </button>
      }
    >
      <CodeBlock code={link} label={m.label} copyLabel={m.copy} />
      <p className="c3">{m.note}</p>
    </Dialog>
  );
}
