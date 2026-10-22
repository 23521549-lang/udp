import type { ProjectRoleWire } from "@udp/shared-types/wire";
import { defineMessages } from "../../i18n";
import type { PermissionKey } from "./roles";

/** Tên bốn vai của project và dòng của ma trận quyền (§10.12 Members) — dùng ở nhiều phân hệ */
export const rolesMessages = defineMessages({
  vi: {
    role: {
      OWNER: "Chủ sở hữu",
      MAINTAINER: "Người duy trì",
      DEVELOPER: "Lập trình viên",
      VIEWER: "Người xem",
    } satisfies Record<ProjectRoleWire, string>,
    permission: {
      read: "Xem flag, rollout, nhật ký",
      editNonProd: "Tạo và sửa flag, rule ở dev/staging",
      editProd: "Sửa flag ở production, tạo và điều khiển rollout",
      admin: "Thành viên, SDK key, environment, quota, xoá project",
    } satisfies Record<PermissionKey, string>,
  },
  en: {
    role: {
      OWNER: "Owner",
      MAINTAINER: "Maintainer",
      DEVELOPER: "Developer",
      VIEWER: "Viewer",
    },
    permission: {
      read: "View flags, rollouts and the audit log",
      editNonProd: "Create and edit flags and rules in dev/staging",
      editProd: "Edit flags in production, create and control rollouts",
      admin: "Members, SDK keys, environments, quota, delete the project",
    },
  },
});
