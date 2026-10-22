import type {
  AdminOverviewWire,
  AdminPlatformWire,
  AdminSystemWire,
} from "@udp/shared-types/wire";
import type { Tone } from "../../components/StatusLabel";
import { backupVerdict, certificateVerdict, idleRisk } from "./platform-model";

/**
 * [Plan #58 UX-27] Dải "Cần xử lý" ở đầu Tổng quan: việc gấp gom từ ba nguồn trang đã tải (số liệu nền tảng, tín hiệu
 * của cụm, sức khoẻ service). Lỗi đứng trước cảnh báo; cùng mức thì tiền và dữ liệu của khách trước: job dọn chưa hết
 * ⇒ tài nguyên mồ côi đang tốn tiền ⇒ project lỗi ⇒ service ⇒ sao lưu ⇒ chứng chỉ ⇒ máy ảo rảnh.
 *
 * THUẦN (`now` truyền vào). Nguồn chưa tải là `undefined` và không góp mục nào; tín hiệu không đọc được không phải việc
 * cần làm nhưng được ĐẾM (`unreadable`), để màn hình không nói "Mọi thứ ổn" khi còn điều nó không biết.
 */
export type AttentionItem =
  | { kind: "cleanup"; tone: Tone; count: number }
  | {
      kind: "orphans";
      tone: Tone;
      count: number;
      usdPerHour: number;
      unpriced: number;
    }
  | { kind: "errorProjects"; tone: Tone; count: number }
  | { kind: "service"; tone: Tone; name: string }
  | { kind: "backup"; tone: Tone; label: string }
  | { kind: "certificate"; tone: Tone; label: string }
  | { kind: "idle"; tone: Tone };

export interface Attention {
  items: AttentionItem[];
  /** Tín hiệu của cụm và service chưa đọc được */
  unreadable: number;
}

const ORDER: readonly AttentionItem["kind"][] = [
  "cleanup",
  "orphans",
  "errorProjects",
  "service",
  "backup",
  "certificate",
  "idle",
];
const rank = (tone: Tone): number =>
  tone === "error" ? 0 : tone === "warn" ? 1 : 2;

export function needsAttention(
  src: {
    overview?: AdminOverviewWire | undefined;
    platform?: AdminPlatformWire | undefined;
    system?: AdminSystemWire | undefined;
  },
  now: number = Date.now(),
): Attention {
  const items: AttentionItem[] = [];
  let unreadable = 0;

  const o = src.overview;
  if (o !== undefined) {
    if (o.jobs.compensationFailed > 0) {
      items.push({
        kind: "cleanup",
        tone: "error",
        count: o.jobs.compensationFailed,
      });
    }
    if (o.orphans.count > 0) {
      items.push({
        kind: "orphans",
        tone: "error",
        count: o.orphans.count,
        usdPerHour: o.orphans.usdPerHour,
        unpriced: o.orphans.unpriced,
      });
    }
    if (o.projects.byStatus.ERROR > 0) {
      items.push({
        kind: "errorProjects",
        tone: "error",
        count: o.projects.byStatus.ERROR,
      });
    }
  }

  const s = src.system;
  if (s !== undefined) {
    for (const svc of [
      ...s.services,
      { name: "database", status: s.database },
    ]) {
      if (svc.status === "down") {
        items.push({ kind: "service", tone: "error", name: svc.name });
      } else if (svc.status === "unknown") {
        unreadable += 1;
      }
    }
  }

  const p = src.platform;
  if (p !== undefined) {
    for (const signal of [p.node, p.postgresVolume, p.backup, p.certificate]) {
      if (signal.state === "unavailable") unreadable += 1;
    }
    if (p.backup.state === "ok") {
      const v = backupVerdict(p.backup, now);
      if (v.tone !== "ok") {
        items.push({ kind: "backup", tone: v.tone, label: v.label });
      }
    }
    if (p.certificate.state === "ok") {
      const v = certificateVerdict(p.certificate, now);
      if (v.tone !== "ok") {
        items.push({ kind: "certificate", tone: v.tone, label: v.label });
      }
    }
    if (p.node.state === "ok" && idleRisk(p.node).tone !== "ok") {
      items.push({ kind: "idle", tone: "warn" });
    }
  }

  items.sort(
    (a, b) =>
      rank(a.tone) - rank(b.tone) ||
      ORDER.indexOf(a.kind) - ORDER.indexOf(b.kind),
  );
  return { items, unreadable };
}
