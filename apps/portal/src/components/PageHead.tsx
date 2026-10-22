import type { ReactNode } from "react";

/** Một chỉ số nhanh ở góc phải của đầu phân hệ */
export interface Mini {
  value: ReactNode;
  label: string;
}

/**
 * Đầu phân hệ (DESIGN.md §4, sửa 29/09/2026): tiêu đề 22px, một câu mô tả, và ở góc phải ba chỉ
 * số nhanh hoặc nút hành động. Không ô icon, không nền gradient — icon của phân hệ đã ở thanh bên.
 * Một component thay markup `.mhead` viết tay ở mọi trang: đổi chuẩn là đổi một chỗ.
 */
export function PageHead({
  title,
  lead,
  minis,
  actions,
}: {
  title: ReactNode;
  lead?: ReactNode;
  /** `undefined` khi số liệu chưa tải — ô chỉ số chưa hiện */
  minis?: readonly Mini[] | undefined;
  actions?: ReactNode;
}) {
  return (
    <div className="mhead">
      <div className="mhead-t">
        <h1>{title}</h1>
        {lead !== undefined && <p>{lead}</p>}
      </div>
      {minis !== undefined && (
        <div className="minis">
          {minis.map((m) => (
            <div key={m.label}>
              <b>{m.value}</b>
              <span>{m.label}</span>
            </div>
          ))}
        </div>
      )}
      {actions !== undefined && <div className="acts">{actions}</div>}
    </div>
  );
}
