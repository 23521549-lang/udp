import { createHash } from "node:crypto";
import { parseIdempotencyKey } from "@udp/adapter-core";
import type { TagCodec } from "../core/plan.js";

/**
 * Tag chuẩn ⇄ label GCP (Plan #26 QĐ-4).
 *
 * Luật label của GCP: khoá bắt đầu bằng chữ thường, khoá và giá trị chỉ `[a-z0-9_-]`, dài
 * ≤ 63; tối đa 64 label. Tag chuẩn của UDP không vừa luật đó ở ba chỗ:
 *
 * - `udp.key` = `{projectId}:{STEP}:{kind}:{name}` có `:` và chữ hoa ⇒ tách thành
 *   `udp-step` (chữ thường), `udp-kind`, `udp-name`, cộng `udp-key` = 40 hex đầu của
 *   SHA-256 khoá gốc. Giải mã dựng lại khoá từ bốn thành phần và KIỂM hash — label bị ai
 *   đó sửa tay thì khoá bị bỏ, không phải một khoá sai được tin.
 * - `udp.ttl` = ISO 8601 ⇒ `udp-ttl` = epoch mili-giây (chỉ chữ số, đi–về không mất gì
 *   với dạng `toISOString()`).
 * - Giá trị tuỳ ý (`udp.owner` là email) ⇒ mã thoát: mỗi byte UTF-8 ngoài `[a-z0-9-]` thành
 *   `_` + hai hex (`@` ⇒ `_40`, `_` ⇒ `_5f`); quá 63 ký tự thì chia khúc sang `<khoá>_2`,
 *   `<khoá>_3`… không bao giờ cắt ngang một mã thoát. Đi–về chính xác cho mọi chuỗi.
 *
 * Khoá `udp.*` đổi `.` thành `-`; khoá ngoài `udp.*` phải tự hợp lệ.
 */

const LABEL_KEY = /^[a-z][a-z0-9_-]{0,62}$/;
const LABEL_VALUE = /^[a-z0-9_-]{0,63}$/;
const MAX_VALUE = 63;
const PLAIN_BYTE = /^[a-z0-9-]$/;
const CHUNK_SUFFIX = /^(.+)_(\d+)$/;
const KEY_PARTS = ["udp-step", "udp-kind", "udp-name", "udp-key"];

export const labelKeyHash = (key: string): string =>
  createHash("sha256").update(key).digest("hex").slice(0, 40);

const toLabelKey = (k: string): string =>
  k.startsWith("udp.") ? `udp-${k.slice(4)}` : k;
const fromLabelKey = (k: string): string =>
  k.startsWith("udp-") ? `udp.${k.slice(4)}` : k;

/** Chuỗi ⇒ các token đã thoát (một ký tự thường, hoặc `_xx`) — đơn vị không được cắt */
function escapedTokens(value: string): string[] {
  return [...Buffer.from(value, "utf8")].map((byte) => {
    const ch = String.fromCharCode(byte);
    return PLAIN_BYTE.test(ch) ? ch : `_${byte.toString(16).padStart(2, "0")}`;
  });
}

function unescapeValue(escaped: string): string {
  const bytes: number[] = [];
  for (let i = 0; i < escaped.length; i++) {
    if (escaped[i] === "_") {
      bytes.push(Number.parseInt(escaped.slice(i + 1, i + 3), 16));
      i += 2;
    } else {
      bytes.push(escaped.charCodeAt(i));
    }
  }
  return Buffer.from(bytes).toString("utf8");
}

/** Một giá trị ⇒ các label `key`, `key_2`, `key_3`… mỗi cái ≤ 63 ký tự */
function chunked(key: string, value: string): [string, string][] {
  const chunks: string[] = [""];
  for (const token of escapedTokens(value)) {
    const last = chunks.length - 1;
    if ((chunks[last] ?? "").length + token.length > MAX_VALUE)
      chunks.push(token);
    else chunks[last] = `${chunks[last] ?? ""}${token}`;
  }
  return chunks.map((c, i) => [i === 0 ? key : `${key}_${String(i + 1)}`, c]);
}

/** Gom các khúc về giá trị gốc theo khoá gốc (bỏ hậu tố `_n`) */
function unchunked(
  raw: Readonly<Record<string, string>>,
): Record<string, string> {
  const parts: Record<string, string[]> = {};
  for (const [k, v] of Object.entries(raw)) {
    const m = CHUNK_SUFFIX.exec(k);
    const base = m?.[1] !== undefined && m[1] in raw ? m[1] : k;
    const index = base === k ? 0 : Number(m?.[2]) - 1;
    (parts[base] ??= [])[index] = v;
  }
  return Object.fromEntries(
    Object.entries(parts).map(([k, chunks]) => [
      k,
      unescapeValue(chunks.join("")),
    ]),
  );
}

export const gcpLabelCodec: TagCodec = {
  encode: (tags) => {
    const out: Record<string, string> = {};
    const put = (key: string, value: string) => {
      for (const [k, v] of chunked(key, value)) out[k] = v;
    };
    for (const [k, v] of Object.entries(tags)) {
      if (k === "udp.key") {
        const parsed = parseIdempotencyKey(v);
        // Khoá sai hình giữ nguyên để `problems` nói ra, không nuốt im lặng
        out["udp-key"] = parsed === null ? v : labelKeyHash(v);
        if (parsed === null) continue;
        put("udp-step", parsed.step.toLowerCase());
        put("udp-kind", parsed.kind);
        put("udp-name", parsed.name);
        continue;
      }
      if (k === "udp.ttl") {
        const ms = Date.parse(v);
        put("udp-ttl", Number.isNaN(ms) ? v : String(ms));
        continue;
      }
      put(toLabelKey(k), v);
    }
    return out;
  },

  decode: (raw) => {
    const { "udp-key": keyHash, ...rest } = raw;
    const values = unchunked(rest);
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(values)) {
      if (KEY_PARTS.includes(k)) continue;
      if (k === "udp-ttl") {
        out["udp.ttl"] = /^\d+$/.test(v)
          ? new Date(Number(v)).toISOString()
          : v;
        continue;
      }
      out[fromLabelKey(k)] = v;
    }
    const project = values["udp-project"];
    const step = values["udp-step"];
    const kind = values["udp-kind"];
    const name = values["udp-name"];
    if (
      project !== undefined &&
      step !== undefined &&
      kind !== undefined &&
      name !== undefined
    ) {
      const key = `${project}:${step.toUpperCase()}:${kind}:${name}`;
      if (labelKeyHash(key) === keyHash) out["udp.key"] = key;
    }
    return out;
  },

  problems: (raw) => {
    const out: string[] = [];
    const entries = Object.entries(raw);
    if (entries.length > 64)
      out.push(`quá 64 label (${String(entries.length)})`);
    for (const [k, v] of entries) {
      if (!LABEL_KEY.test(k)) out.push(`khoá label ${k} không hợp lệ`);
      if (!LABEL_VALUE.test(v))
        out.push(`giá trị label ${k}=${v} không hợp lệ`);
    }
    return out;
  },
};
