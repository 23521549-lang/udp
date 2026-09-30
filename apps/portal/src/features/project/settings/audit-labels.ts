import type { AuditEntryWire, PublicMemberWire } from "@udp/shared-types/wire";
import { messagesOf } from "../../../i18n";
import { domainName } from "../../domain/domain-labels";
import { auditMessages } from "./audit.messages";

/**
 * [Plan #58 UX-35] Nhật ký kiểm toán đọc được: ai làm, câu dễ đọc, đối tượng — THUẦN (đọc ngôn ngữ lúc gọi, như
 * `domainName`). Mã hành động là của máy chủ (`services/*`: `action: "flag.create"`…); mã lạ giữ nguyên.
 */
export const AUDIT_GROUPS = {
  flag: [
    "flag.create",
    "flag.update",
    "flag.activate",
    "flag.archive",
    "flag.restore",
    "flag.env.update",
    "flag.rule.update",
    "flag.variants.update",
  ],
  rollout: ["rollout.create", "rollout.intent", "rollout.create.compensated"],
  segment: ["segment.create", "segment.update", "segment.delete"],
  sdkKey: ["sdkkey.create", "sdkkey.revoke"],
  environment: [
    "environment.create",
    "environment.update",
    "environment.delete",
    "environment.apply.add",
    "environment.apply.remove",
  ],
  member: [
    "member.add",
    "member.remove",
    "member.role.update",
    "member.ownership.transfer",
    "invitation.create",
    "invitation.revoke",
    "invitation.accept",
  ],
  infra: [
    "domain.config.set",
    "domain.config.apply",
    "domain.upgrade",
    "domain.reapply",
    "cicd.webhook_secret.create",
    "cicd.webhook_secret.rotate",
    "cicd.webhook.rejected",
    "deployment.approve",
    "cloud.credential.set",
    "project.provision",
    "provision.cancel",
  ],
  project: [
    "project.create",
    "project.delete",
    "project.quota.update",
    "project.ttl.update",
    "project.ttl.warn",
    "project.ttl.expired",
    "project.ttl.teardown",
    "project.ttl.teardown-blocked",
  ],
} as const;
export type AuditGroup = keyof typeof AUDIT_GROUPS;
export type AuditActionCode = (typeof AUDIT_GROUPS)[AuditGroup][number];

const copy = () => messagesOf(auditMessages);
const isKnown = (code: string): code is AuditActionCode =>
  Object.prototype.hasOwnProperty.call(copy().action, code);

/** Cụm động từ của một mã ("tạo flag"); mã lạ ⇒ `undefined`, chỗ gọi hiện nguyên mã */
export const auditActionText = (code: string): string | undefined =>
  isKnown(code) ? copy().action[code] : undefined;

/** Người làm: tên thành viên (email nếu thiếu tên); người đã rời project ⇒ mã ngắn; job nền ⇒ UDP */
export function auditActor(
  entry: AuditEntryWire,
  members: readonly PublicMemberWire[],
): string {
  const t = copy();
  if (entry.actorType === "SYSTEM") return t.system;
  if (entry.actorType === "SDK") return t.sdk;
  const member = members.find((x) => x.userId === entry.actorUserId);
  if (member !== undefined) return member.user.name || member.user.email;
  return t.formerMember((entry.actorUserId ?? "?").slice(0, 8));
}

/** Trường đọc được của đối tượng, theo thứ tự ưu tiên, trong `after` rồi `before` */
const TARGET_FIELDS = [
  "key",
  "name",
  "email",
  "label",
  "flagKey",
  "workloadName",
] as const;

function field(value: unknown, key: string): string | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const v = (value as Record<string, unknown>)[key];
  return typeof v === "string" && v !== "" ? v : undefined;
}

/**
 * Đối tượng của dòng: key flag, tên, email… lấy từ chính bản ghi; thành viên thì tra email; domain thì tên đọc
 * được. Không có gì đọc được ⇒ 8 ký tự đầu của mã (vẫn đủ để đối chiếu).
 */
export function auditTarget(
  entry: AuditEntryWire,
  members: readonly PublicMemberWire[],
): string {
  for (const key of TARGET_FIELDS) {
    const hit = field(entry.after, key) ?? field(entry.before, key);
    if (hit !== undefined) return hit;
  }
  const domain =
    field(entry.after, "domainType") ?? field(entry.before, "domainType");
  if (domain !== undefined) return domainName(domain);
  const member = members.find((x) => x.userId === entry.targetId);
  if (member !== undefined) return member.user.email;
  return entry.targetId.slice(0, 8);
}

/** Câu của một dòng: "Lan tạo flag"; mã lạ ⇒ `undefined` (dòng hiện người làm và nguyên mã) */
export function auditSentence(
  entry: AuditEntryWire,
  members: readonly PublicMemberWire[],
): string | undefined {
  const action = auditActionText(entry.action);
  return action === undefined
    ? undefined
    : copy().sentence(auditActor(entry, members), action);
}

/** Nhãn một lựa chọn của ô lọc: viết hoa chữ đầu của cụm động từ */
export const auditOptionLabel = (code: AuditActionCode): string => {
  const text = copy().action[code];
  return text.charAt(0).toLocaleUpperCase() + text.slice(1);
};
