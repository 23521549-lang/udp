import type { RolloutStatusWire } from "@udp/shared-types/wire";
import { CircleCheck, CirclePause, CircleX } from "lucide-react";
import { Icon } from "../../components/Icon";
import { ProgressRing } from "../../components/ProgressRing";

/**
 * Trạng thái rollout (DESIGN.md §5): đang chạy là vòng tiến độ màu `--accent`; ba trạng
 * thái kết thúc là icon Lucide trong vòng tròn — tạm dừng (cam), hoàn tất (xanh lá),
 * rollback (đỏ). Luôn kèm CHỮ: màu không bao giờ là kênh duy nhất.
 */
export const ROLLOUT_STATUS_LABEL: Record<RolloutStatusWire, string> = {
  PENDING: "Đang chờ",
  IN_PROGRESS: "Đang chạy",
  PAUSED: "Tạm dừng",
  DONE: "Hoàn tất",
  FAILED: "Đã rollback",
};

export function RolloutStatusIcon({
  status,
  percent,
}: {
  status: RolloutStatusWire;
  percent: number;
}) {
  switch (status) {
    case "PAUSED":
      return <Icon of={CirclePause} style={{ color: "var(--amber)" }} />;
    case "DONE":
      return <Icon of={CircleCheck} style={{ color: "var(--green)" }} />;
    case "FAILED":
      return <Icon of={CircleX} style={{ color: "var(--red)" }} />;
    case "PENDING":
      return <ProgressRing percent={0} dashed />;
    case "IN_PROGRESS":
      return <ProgressRing percent={percent} tone="accent" />;
  }
}

export function RolloutStatusLabel({
  status,
  percent = 0,
}: {
  status: RolloutStatusWire;
  percent?: number;
}) {
  return (
    <span className="stt">
      <RolloutStatusIcon status={status} percent={percent} />
      {ROLLOUT_STATUS_LABEL[status]}
    </span>
  );
}
