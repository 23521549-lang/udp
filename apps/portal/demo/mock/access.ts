import type { ProjectRoleWire } from "@udp/shared-types/wire";
import type { Db, ProjectRecord } from "./db";

/**
 * [Plan #55] Vai HIỆU LỰC trong bản xem thử — cùng luật với Service 1 (`core/access/project-access.ts`): vai cao
 * nhất giữa hàng thành viên trực tiếp và vai của các nhóm người đó thuộc mà project đã cấp. Không có vai nào ⇒
 * project chỉ trang quản trị thấy.
 */

const RANK: Record<ProjectRoleWire, number> = {
  VIEWER: 0,
  DEVELOPER: 1,
  MAINTAINER: 2,
  OWNER: 3,
};

export function effectiveRole(
  db: Db,
  p: ProjectRecord,
  userId: string,
): ProjectRoleWire | null {
  const sources: ProjectRoleWire[] = [
    ...p.members.filter((m) => m.userId === userId).map((m) => m.projectRole),
    ...p.teamGrants
      .filter((g) =>
        db.teams.some(
          (t) =>
            t.id === g.teamId && t.members.some((m) => m.userId === userId),
        ),
      )
      .map((g) => g.projectRole),
  ];
  return sources.reduce<ProjectRoleWire | null>(
    (best, r) => (best === null || RANK[r] > RANK[best] ? r : best),
    null,
  );
}

/** Đặt lại `myRole` và `adminOnly` của mọi project sau một thay đổi nhóm, thành viên nhóm hay quyền của nhóm */
export function refreshMyAccess(db: Db): void {
  for (const p of db.projects) {
    const role = effectiveRole(db, p, db.me.id);
    p.adminOnly = role === null;
    if (role !== null) p.project.myRole = role;
  }
}
