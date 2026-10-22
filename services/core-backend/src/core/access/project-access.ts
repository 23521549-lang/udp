import type { Prisma, ProjectRole, ProjectStatus } from "@udp/db";
import { prisma } from "../db.js";

/**
 * [v4.11, Plan #55 QĐ-2, D-P48] Vai HIỆU LỰC của một người trên một project — chỗ DUY NHẤT tính nó.
 *
 * Vai hiệu lực = vai CAO NHẤT giữa hàng `project_members` của người đó và các `project_team_grants` của những
 * nhóm họ thuộc. Bốn nơi hỏi — `requireMinProjectRole`, danh sách project, trang chủ, luồng SSE (qua middleware)
 * — đều đi qua ba mảnh dưới đây, nên "vào được project" và "vai gì" không thể lệch nhau giữa hai màn:
 *
 *   `accessibleBy`   điều kiện `where` — người dùng có ÍT NHẤT một nguồn vai trên project;
 *   `roleSourcesOf`  phần `select` đọc mọi nguồn vai của người dùng trong CÙNG truy vấn với project;
 *   `effectiveRoleOf` gộp các nguồn thành một vai.
 *
 * Không cache: rời nhóm là mất quyền đến từ nhóm ở request kế tiếp.
 */

/**
 * Thứ bậc, KHÔNG phải danh sách.
 *
 * `requireMinProjectRole("MAINTAINER")` phải cho OWNER đi qua. Nếu viết theo
 * kiểu khớp tập — `requireProjectRole("MAINTAINER")` rồi kiểm `roles.includes` —
 * thì chủ sở hữu project nhận 403 trên chính project của mình, và lỗi đó chỉ lộ
 * ra ở đúng route hiếm dùng nhất.
 *
 * `Record<ProjectRole, number>` khai đủ bốn khoá chứ không phải object literal
 * tra bằng index: với `noUncheckedIndexedAccess`, kiểu tra index là
 * `number | undefined`, và mọi phép so sánh với `undefined` đều lặng lẽ thành
 * `false` — tức là từ chối tất cả, hoặc cho qua tất cả, tuỳ chiều so sánh.
 */
const RANK: Record<ProjectRole, number> = {
  VIEWER: 0,
  DEVELOPER: 1,
  MAINTAINER: 2,
  OWNER: 3,
};

/**
 * [v4.5] Vai trò `role` có đủ `minimum` không — CÙNG bảng thứ bậc với
 * `requireMinProjectRole`, cho những chỗ chỉ biết mức cần SAU khi đọc tài nguyên
 * (env production cần MAINTAINER, §2.2). Không bảng thứ bậc thứ hai.
 */
export function hasMinProjectRole(
  role: ProjectRole | null | undefined,
  minimum: ProjectRole,
): boolean {
  return role != null && RANK[role] >= RANK[minimum];
}

/** Điều kiện `where` trên `Project`: người dùng là thành viên trực tiếp, hoặc thuộc một nhóm được cấp quyền */
export const accessibleBy = (userId: string) =>
  ({
    OR: [
      { members: { some: { userId } } },
      { teamGrants: { some: { team: { members: { some: { userId } } } } } },
    ],
  }) satisfies Prisma.ProjectWhereInput;

/** Phần `select` trên `Project` mang mọi nguồn vai của người dùng — đưa thẳng vào `effectiveRoleOf` */
export const roleSourcesOf = (userId: string) =>
  ({
    members: { where: { userId }, select: { projectRole: true } },
    teamGrants: {
      where: { team: { members: { some: { userId } } } },
      select: { projectRole: true },
    },
  }) satisfies Prisma.ProjectSelect;

export interface RoleSources {
  members: readonly { projectRole: ProjectRole }[];
  teamGrants: readonly { projectRole: ProjectRole }[];
}

/** Vai cao nhất trong các nguồn; `null` khi người dùng không có nguồn nào */
export function effectiveRoleOf(sources: RoleSources): ProjectRole | null {
  let best: ProjectRole | null = null;
  for (const { projectRole } of [...sources.members, ...sources.teamGrants]) {
    if (best === null || RANK[projectRole] > RANK[best]) best = projectRole;
  }
  return best;
}

/**
 * Vai của một hàng ĐÃ lọc bằng `accessibleBy`. Không có vai ở đây là mâu thuẫn dữ liệu (một nguồn bị xoá giữa hai
 * phần của truy vấn): ném, tuyệt đối không `?? "VIEWER"` — đó là hạ cấp phân quyền im lặng.
 */
export function roleOfAccessible(
  row: RoleSources & { id: string },
): ProjectRole {
  const role = effectiveRoleOf(row);
  if (role === null) {
    throw new Error(`project ${row.id} không có vai nào của người gọi`);
  }
  return role;
}

/** Trạng thái của project và vai hiệu lực của người dùng trên nó; `null` khi project không tồn tại */
export async function projectAccessOf(
  projectId: string,
  userId: string,
): Promise<{ status: ProjectStatus; role: ProjectRole | null } | null> {
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { status: true, ...roleSourcesOf(userId) },
  });
  return project === null
    ? null
    : { status: project.status, role: effectiveRoleOf(project) };
}
