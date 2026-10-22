import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ProjectInvitationWire } from "@udp/shared-types/wire";
import { useState } from "react";
import { toast } from "../../../components/Toast";
import { useMessages } from "../../../i18n";
import { messageOf } from "../../../lib/errors";
import { qk } from "../../../lib/query-keys";
import { invitationApi } from "../../invitation/invitation-api";
import { InviteLinkDialog } from "../../invitation/InviteLinkDialog";
import { PendingInvitations } from "../../invitation/PendingInvitations";
import { invitationMessages } from "../../invitation/invitation.messages";
import { rolesMessages } from "../roles.messages";

/**
 * [Plan #55] Lời mời đang chờ của project (chỉ OWNER — cùng cột với thêm thành viên, §2.2): tạo lại đường dẫn
 * (lời cũ hết dùng được) hay thu hồi.
 */
export function ProjectInvitations({ projectId }: { projectId: string }) {
  const roles = useMessages(rolesMessages).role;
  const pending = useMessages(invitationMessages).pending;
  const queryClient = useQueryClient();
  const [link, setLink] = useState<{ email: string; token: string } | null>(
    null,
  );
  const invitations = useQuery({
    queryKey: qk.projectInvitations(projectId),
    queryFn: () => invitationApi.ofProject(projectId),
  });
  const refresh = () =>
    queryClient.invalidateQueries({
      queryKey: qk.projectInvitations(projectId),
    });

  const reissue = useMutation({
    mutationFn: (x: ProjectInvitationWire) =>
      invitationApi.inviteToProject(projectId, {
        email: x.email,
        projectRole: x.projectRole,
      }),
    onSuccess: async (created) => {
      setLink({ email: created.invitation.email, token: created.token });
      await refresh();
    },
    onError: (e) => toast.error(messageOf(e)),
  });
  const revoke = useMutation({
    mutationFn: (x: ProjectInvitationWire) =>
      invitationApi.revokeInProject(projectId, x.id),
    onSuccess: async (_d, x) => {
      toast.info(pending.revoked(x.email));
      await refresh();
    },
    onError: (e) => toast.error(messageOf(e)),
  });

  if (invitations.data === undefined) return null;
  return (
    <>
      <PendingInvitations
        items={invitations.data.invitations}
        roleOf={(x) => roles[x.projectRole]}
        busy={reissue.isPending || revoke.isPending}
        onReissue={(x) => reissue.mutate(x)}
        onRevoke={(x) => revoke.mutate(x)}
      />
      {link !== null && (
        <InviteLinkDialog
          email={link.email}
          token={link.token}
          onClose={() => setLink(null)}
        />
      )}
    </>
  );
}
