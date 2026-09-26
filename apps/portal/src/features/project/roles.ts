import type { ProjectRoleWire } from "@udp/shared-types/wire";

/**
 * Thứ bậc vai — CÙNG bảng với `requireMinProjectRole` của Service 1. Portal dùng nó để
 * ẨN hành động; chặn thật vẫn ở backend, nên ẩn nút không bao giờ là lớp bảo vệ duy nhất.
 */
const RANK: Record<ProjectRoleWire, number> = {
  VIEWER: 0,
  DEVELOPER: 1,
  MAINTAINER: 2,
  OWNER: 3,
};

export const can = (role: ProjectRoleWire, minimum: ProjectRoleWire): boolean =>
  RANK[role] >= RANK[minimum];

export const ROLE_LABEL: Record<ProjectRoleWire, string> = {
  OWNER: "Chủ sở hữu",
  MAINTAINER: "Người duy trì",
  DEVELOPER: "Lập trình viên",
  VIEWER: "Người xem",
};

/** Ma trận quyền hiển thị trong màn Thành viên (§10.12 Members) — khớp §2.2 */
export const PERMISSIONS: { action: string; min: ProjectRoleWire }[] = [
  { action: "Xem flag, rollout, nhật ký", min: "VIEWER" },
  { action: "Tạo và sửa flag, rule ở dev/staging", min: "DEVELOPER" },
  {
    action: "Sửa flag ở production, tạo và điều khiển rollout",
    min: "MAINTAINER",
  },
  {
    action: "Thành viên, SDK key, environment, quota, xoá project",
    min: "OWNER",
  },
];
