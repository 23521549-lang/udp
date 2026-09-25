import type { TagCodec } from "../core/plan.js";

/**
 * Tag AWS giữ nguyên dạng chuẩn (`udp.project`, `udp.key = {projectId}:{step}:{kind}:{name}`)
 * — AWS cho phép `.` và `:` — chỉ kiểm luật của AWS: khoá ≤ 128, giá trị ≤ 256 ký tự, tập
 * ký tự `\p{L}\p{Z}\p{N}_.:/=+-@`, và khoá không bắt đầu bằng `aws:` (tiền tố dành riêng).
 */
const ALLOWED = /^[\p{L}\p{Z}\p{N}_.:/=+\-@]*$/u;

export const awsTagCodec: TagCodec = {
  encode: (tags) => ({ ...tags }),
  decode: (raw) => ({ ...raw }),
  problems: (raw) =>
    Object.entries(raw).flatMap(([k, v]) => [
      ...(k.length === 0 || k.length > 128 ? [`khoá ${k}: độ dài 1..128`] : []),
      ...(v.length > 256 ? [`giá trị của ${k}: tối đa 256 ký tự`] : []),
      ...(k.toLowerCase().startsWith("aws:")
        ? [`khoá ${k}: tiền tố aws: dành riêng`]
        : []),
      ...(!ALLOWED.test(k) ? [`khoá ${k}: có ký tự AWS không nhận`] : []),
      ...(!ALLOWED.test(v)
        ? [`giá trị của ${k}: có ký tự AWS không nhận`]
        : []),
    ]),
};

/** Dạng `TagSpecifications`/`Tags` của EC2, IAM, EKS */
export const ec2Tags = (tags: Readonly<Record<string, string>>) =>
  Object.entries(tags).map(([Key, Value]) => ({ Key, Value }));

export const tagsFromList = (
  list:
    | readonly { Key?: string | undefined; Value?: string | undefined }[]
    | undefined,
): Record<string, string> =>
  Object.fromEntries(
    (list ?? []).flatMap((t) =>
      t.Key === undefined ? [] : [[t.Key, t.Value ?? ""] as const],
    ),
  );
