import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { FlagDetailWire } from "@udp/shared-types/wire";
import { Archive, Play } from "lucide-react";
import { useState } from "react";
import { ConfirmDialog } from "../../../components/ConfirmDialog";
import { Icon } from "../../../components/Icon";
import { toast } from "../../../components/Toast";
import { messageOf } from "../../../lib/errors";
import { qkPrefix } from "../../../lib/query-keys";
import { flagApi } from "../flag-api";
import { useProjectContext } from "../../project/ProjectLayout";
import { can } from "../../project/roles";

export function LifecycleActions({ flag }: { flag: FlagDetailWire }) {
  const { project } = useProjectContext();
  const queryClient = useQueryClient();
  const [confirm, setConfirm] = useState<"ACTIVE" | "ARCHIVED" | null>(null);

  /**
   * [Plan #44] Đổi vòng đời là thay đổi TOÀN CỤC: máy chủ đòi gõ lại key (428
   * `CONFIRMATION_REQUIRED`, §8.4). Bản trước không gửi key nên hai nút luôn nhận 428.
   */
  const update = useMutation({
    mutationFn: (v: {
      lifecycleStatus: "ACTIVE" | "ARCHIVED";
      confirmFlagKey: string;
    }) =>
      flagApi.update(project.id, flag.id, {
        lastKnownUpdatedAt: flag.updatedAt,
        ...v,
      }),
    onSuccess: async (_d, { lifecycleStatus: status }) => {
      setConfirm(null);
      toast.info(status === "ACTIVE" ? "Đã kích hoạt flag" : "Đã lưu trữ flag");
      await queryClient.invalidateQueries({
        queryKey: qkPrefix.flagOf(project.id, flag.id),
      });
      await queryClient.invalidateQueries({
        queryKey: qkPrefix.flagsOf(project.id),
      });
    },
  });

  if (
    !can(project.myRole, "MAINTAINER") ||
    flag.lifecycleStatus === "ARCHIVED"
  ) {
    return null;
  }

  return (
    <div className="sect">
      {flag.lifecycleStatus === "DRAFT" && (
        <button
          type="button"
          className="btn"
          onClick={() => setConfirm("ACTIVE")}
        >
          <Icon of={Play} />
          Kích hoạt
        </button>
      )}
      <button
        type="button"
        className="btn danger"
        onClick={() => setConfirm("ARCHIVED")}
      >
        <Icon of={Archive} />
        Lưu trữ
      </button>
      {confirm !== null && (
        <ConfirmDialog
          title={confirm === "ACTIVE" ? "Kích hoạt flag?" : "Lưu trữ flag?"}
          description={
            confirm === "ACTIVE"
              ? "SDK sẽ bắt đầu nhận flag này ở mọi environment."
              : "SDK sẽ không còn nhận flag này. Flag đang có rollout chạy thì không lưu trữ được."
          }
          confirmLabel={confirm === "ACTIVE" ? "Kích hoạt" : "Lưu trữ"}
          danger={confirm === "ARCHIVED"}
          typeToConfirm={flag.key}
          busy={update.isPending}
          error={update.isError ? messageOf(update.error) : undefined}
          onConfirm={(typed) =>
            update.mutate({
              lifecycleStatus: confirm,
              confirmFlagKey: typed ?? "",
            })
          }
          onClose={() => {
            setConfirm(null);
            update.reset();
          }}
        />
      )}
    </div>
  );
}
