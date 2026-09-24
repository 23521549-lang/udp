import type { ReactNode } from "react";
import { EnvSwitcher, useProjectContext } from "./ProjectLayout";

/**
 * Thanh đầu trang trong một project (DESIGN.md §4): bộ chọn môi trường, dấu `/`,
 * breadcrumb, hành động bên phải. `envScoped = false` cho trang không thuộc env nào
 * (Segment, Cài đặt dự án) — hiện bộ chọn ở đó là nói dối về phạm vi dữ liệu.
 */
export function ProjectBar({
  title,
  actions,
  envScoped = true,
}: {
  title: ReactNode;
  actions?: ReactNode;
  envScoped?: boolean;
}) {
  const { project } = useProjectContext();
  return (
    <div className="bar">
      {envScoped && (
        <>
          <EnvSwitcher />
          <span className="sep c3">/</span>
        </>
      )}
      <div className="crumbs">
        <span className="c3">{project.name}</span>
        <span className="sep">/</span>
        <b>{title}</b>
      </div>
      {actions !== undefined && <div className="r">{actions}</div>}
    </div>
  );
}
