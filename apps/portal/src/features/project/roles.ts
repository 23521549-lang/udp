import type { ProjectRoleWire } from "@udp/shared-types/wire";

/**
 * Thứ bậc vai — CÙNG bảng với `requireMinProjectRole` của Service 1. Portal dùng nó để
 * ẨN hành động; chặn thật vẫn ở backend, nên ẩn nút không bao giờ là lớp bảo vệ duy nhất.
 * Tên vai hiển thị ở `roles.messages.ts`.
 */
const RANK: Record<ProjectRoleWire, number> = {
  VIEWER: 0,
  DEVELOPER: 1,
  MAINTAINER: 2,
  OWNER: 3,
};

export const can = (role: ProjectRoleWire, minimum: ProjectRoleWire): boolean =>
  RANK[role] >= RANK[minimum];

export type PermissionKey = "read" | "editNonProd" | "editProd" | "admin";

/** Ma trận quyền hiển thị trong màn Thành viên (§10.12 Members) — khớp §2.2; chữ ở `roles.messages.ts` */
export const PERMISSIONS: { key: PermissionKey; min: ProjectRoleWire }[] = [
  { key: "read", min: "VIEWER" },
  { key: "editNonProd", min: "DEVELOPER" },
  { key: "editProd", min: "MAINTAINER" },
  { key: "admin", min: "OWNER" },
];
