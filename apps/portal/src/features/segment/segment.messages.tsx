import type { ReactNode } from "react";
import { count, defineMessages } from "../../i18n";
import { formatNumber } from "../../lib/format";

/** Chữ của trang Segment: danh sách, panel xem nhanh, hộp tạo/sửa và cảnh báo trần dung lượng */
export const segmentMessages = defineMessages({
  vi: {
    title: "Segment",
    create: "Tạo segment",
    lead: "Nhóm người dùng dùng chung cho rule ở mọi environment.",
    miniSegments: "segment",
    miniStorage: "dung lượng",
    empty: "Chưa có segment nào",
    list: "Danh sách segment",
    summary: (conditions: number, users: number) =>
      `${String(conditions)} điều kiện, ${formatNumber(users)} người dùng`,
    usedBy: (flags: number) => `${String(flags)} flag dùng`,
    deleted: "Đã xoá segment",
    details: "Chi tiết segment",
    edit: "Sửa segment",
    delete: "Xoá segment",
    close: "Đóng",
    noDescription: "Chưa có mô tả.",
    matchesWhen: "Khớp khi",
    keyIn: (list: ReactNode) => <>targetingKey thuộc {list}</>,
    flagsUsing: "Flag đang dùng",
    unused: "Chưa rule nào dùng segment này.",
    deleteTitle: (name: string) => `Xoá segment ${name}?`,
    deleteDescription: "Segment đang được rule dùng thì không xoá được.",
    deleteConfirm: "Xoá",
    saved: "Đã lưu segment",
    editTitle: (name: string) => `Sửa ${name}`,
    dialogDescription:
      "Khớp khi targetingKey nằm trong danh sách, HOẶC mọi điều kiện thuộc tính đều đúng.",
    cancel: "Huỷ",
    saving: "Đang lưu…",
    save: "Lưu",
    name: "Tên",
    description: "Mô tả",
    keyInLabel: "targetingKey thuộc",
    keyList: "Danh sách targetingKey",
    orAll: "Hoặc mọi điều kiện sau đều đúng",
    conditionsOf: "segment",
    over: (lower: string, max: string) =>
      `Vượt trần dung lượng của project: sau khi lưu ít nhất ${lower} trên ${max}. Máy chủ sẽ từ chối.`,
    maybe: (lower: string, max: string) =>
      `Sát trần dung lượng của project (khoảng ${lower} trên ${max}); có thể bị từ chối.`,
    ok: (lower: string, max: string) =>
      `Dung lượng sau khi lưu: khoảng ${lower} trên ${max}.`,
    countFull: (n: ReactNode, max: ReactNode) => (
      <>
        Project đã có {n}/{max} segment: tạo thêm sẽ bị từ chối.
      </>
    ),
  },
  en: {
    title: "Segments",
    create: "Create segment",
    lead: "User groups shared by rules in every environment.",
    miniSegments: "segments",
    miniStorage: "storage",
    empty: "No segments yet",
    list: "Segment list",
    summary: (conditions: number, users: number) =>
      `${count(conditions, "condition", "conditions")}, ${count(users, "user", "users")}`,
    usedBy: (flags: number) => `Used by ${count(flags, "flag", "flags")}`,
    deleted: "Segment deleted",
    details: "Segment details",
    edit: "Edit segment",
    delete: "Delete segment",
    close: "Close",
    noDescription: "No description yet.",
    matchesWhen: "Matches when",
    keyIn: (list: ReactNode) => <>targetingKey is one of {list}</>,
    flagsUsing: "Flags using it",
    unused: "No rule uses this segment yet.",
    deleteTitle: (name: string) => `Delete segment ${name}?`,
    deleteDescription: "A segment that a rule uses cannot be deleted.",
    deleteConfirm: "Delete",
    saved: "Segment saved",
    editTitle: (name: string) => `Edit ${name}`,
    dialogDescription:
      "Matches when the targetingKey is in the list, OR every attribute condition is true.",
    cancel: "Cancel",
    saving: "Saving…",
    save: "Save",
    name: "Name",
    description: "Description",
    keyInLabel: "targetingKey is one of",
    keyList: "targetingKey list",
    orAll: "Or all of these conditions are true",
    conditionsOf: "segment",
    over: (lower: string, max: string) =>
      `Over the project's storage limit: at least ${lower} of ${max} after saving. The server will reject it.`,
    maybe: (lower: string, max: string) =>
      `Close to the project's storage limit (about ${lower} of ${max}); it may be rejected.`,
    ok: (lower: string, max: string) =>
      `Storage after saving: about ${lower} of ${max}.`,
    countFull: (n: ReactNode, max: ReactNode) => (
      <>
        The project already has {n}/{max} segments: creating more will be
        rejected.
      </>
    ),
  },
});
