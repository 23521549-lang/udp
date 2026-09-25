import type { TagCodec } from "../core/plan.js";

/**
 * Tag Azure giữ nguyên dạng chuẩn (Plan #26 QĐ-4: Azure cho phép `.` trong khoá và `:`
 * trong giá trị) — chỉ kiểm luật của ARM: tối đa 50 tag, khoá ≤ 512 và không chứa
 * `< > % & \ ? /`, không bắt đầu bằng tiền tố dành riêng `microsoft`, `azure`,
 * `windows`; giá trị ≤ 256 ký tự.
 */
const FORBIDDEN_IN_KEY = /[<>%&\\?/]/;
const RESERVED_PREFIXES = ["microsoft", "azure", "windows"];
const MAX_TAGS = 50;

export const azureTagCodec: TagCodec = {
  encode: (tags) => ({ ...tags }),
  decode: (raw) => ({ ...raw }),
  problems: (raw) => {
    const entries = Object.entries(raw);
    return [
      ...(entries.length > MAX_TAGS
        ? [`quá ${String(MAX_TAGS)} tag (${String(entries.length)})`]
        : []),
      ...entries.flatMap(([k, v]) => [
        ...(k.length === 0 || k.length > 512
          ? [`khoá ${k}: độ dài 1..512`]
          : []),
        ...(FORBIDDEN_IN_KEY.test(k)
          ? [`khoá ${k}: có ký tự ARM không nhận`]
          : []),
        ...(RESERVED_PREFIXES.some((p) => k.toLowerCase().startsWith(p))
          ? [`khoá ${k}: tiền tố dành riêng của Azure`]
          : []),
        ...(v.length > 256 ? [`giá trị của ${k}: tối đa 256 ký tự`] : []),
      ]),
    ];
  },
};
