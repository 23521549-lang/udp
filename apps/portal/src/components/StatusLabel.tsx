import {
  CircleAlert,
  CircleCheck,
  CircleHelp,
  CircleX,
  LoaderCircle,
  type LucideIcon,
} from "lucide-react";
import type { ReactNode } from "react";
import { Icon } from "./Icon";

/** Năm tone trạng thái của DESIGN.md §5 — không có tone thứ sáu, không chấm màu */
export type Tone = "ok" | "running" | "warn" | "error" | "unknown";

const TONES: Record<Tone, LucideIcon> = {
  ok: CircleCheck,
  running: LoaderCircle,
  warn: CircleAlert,
  error: CircleX,
  unknown: CircleHelp,
};

/**
 * Trạng thái bằng icon Lucide kèm chữ (DESIGN.md §5: "Không dùng chấm màu"). Một bảng tone duy
 * nhất: lưới sức khoẻ, sơ đồ kiến trúc, trang chủ và bảng điều khiển cùng nói một ngôn ngữ màu.
 */
export function StatusLabel({
  tone,
  children,
}: {
  tone: Tone;
  children: ReactNode;
}) {
  return (
    <span className={`sl ${tone}`}>
      <Icon of={TONES[tone]} />
      {children}
    </span>
  );
}
