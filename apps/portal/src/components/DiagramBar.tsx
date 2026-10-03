import { useMessages } from "../i18n";
import { componentsMessages } from "./components.messages";

/**
 * Thanh trên một sơ đồ có cạnh (Plan #57 QĐ-3, QĐ-6): chú giải hai loại nét, một câu nói cạnh nghĩa là gì, và nút
 * đổi sang bản bảng thay thế — một khuôn cho sơ đồ của project và sơ đồ nền tảng.
 */
export function DiagramBar({
  solid,
  dashed,
  note,
  asTable,
  onToggle,
}: {
  /** Nghĩa của nét liền */
  solid: string;
  /** Nghĩa của nét đứt */
  dashed: string;
  note: string;
  asTable: boolean;
  onToggle: () => void;
}) {
  const m = useMessages(componentsMessages).diagram;
  return (
    <div className="sys-bar">
      <span className="sys-legend">
        <span className="lg">
          <i className="sys-line" />
          {solid}
        </span>
        <span className="lg">
          <i className="sys-line dash" />
          {dashed}
        </span>
        <span className="c3">{note}</span>
      </span>
      <button
        type="button"
        className="btn"
        aria-pressed={asTable}
        onClick={onToggle}
      >
        {asTable ? m.asDiagram : m.asTable}
      </button>
    </div>
  );
}
