import { CONDITION_LIMITS } from "@udp/config/constants";
import {
  compareSemver,
  parseSemver,
  type AttributeCondition,
  type Semver,
} from "@udp/shared-types";

/**
 * Điều kiện thuộc tính đã BIÊN DỊCH — dựng một lần mỗi snapshot (§6.5 "tối ưu ở
 * tầng dựng cache"), chạy mỗi lần đánh giá.
 *
 * Ngữ nghĩa [v4.6], một định nghĩa cho SDK và OFREP (I26):
 *   - Tra thuộc tính bằng KHOÁ PHẲNG, chỉ thuộc tính RIÊNG (`Object.hasOwn`) —
 *     `context["toString"]` không được trả về hàm của prototype.
 *   - Thuộc tính vắng hoặc `null` ⇒ false với MỌI toán tử, kể cả `neq`/`nin`:
 *     "country neq VN" không được khớp một người không khai quốc gia.
 *   - So CHẶT, không ép kiểu: `eq 5` không khớp `"5"`; khác kiểu thì cả `eq` lẫn
 *     `neq` đều false (không so được), nên `neq` KHÔNG phải phủ định của `eq`.
 *   - Chuỗi so sau khi chuẩn hoá NFC ở CẢ HAI phía — cùng luật với `bucketOf`
 *     (I2): "Nguyễn" gõ trên iOS (NFD) và Android (NFC) là một người.
 */

export type EvalContext = Readonly<Record<string, unknown>>;
export type CompiledCondition = (context: EvalContext) => boolean;

/** Giá trị của một thuộc tính, hoặc `undefined` khi vắng/`null` */
export function attributeOf(context: EvalContext, name: string): unknown {
  if (!Object.hasOwn(context, name)) return undefined;
  const value = context[name];
  return value === null ? undefined : value;
}

export const nfc = (s: string): string => s.normalize("NFC");

/**
 * Context với mọi chuỗi cấp một đã NFC — làm MỘT lần mỗi lượt đánh giá, không
 * phải mỗi điều kiện. Giá trị không phải chuỗi giữ nguyên.
 */
export function normalizeContext(context: EvalContext): EvalContext {
  // Không prototype: `out["__proto__"] = v` trên `{}` ĐỔI prototype thay vì tạo
  // thuộc tính — context từ `JSON.parse` mang được khoá đó như một khoá thường
  const out = Object.create(null) as Record<string, unknown>;
  for (const key of Object.keys(context)) {
    const value = context[key];
    out[key] = typeof value === "string" ? nfc(value) : value;
  }
  return out;
}

const isFiniteNumber = (v: unknown): v is number =>
  typeof v === "number" && Number.isFinite(v);

function compare(
  attribute: string,
  test: (v: number) => boolean,
): CompiledCondition {
  return (ctx) => {
    const v = attributeOf(ctx, attribute);
    return isFiniteNumber(v) && test(v);
  };
}

function onString(
  attribute: string,
  test: (v: string) => boolean,
): CompiledCondition {
  return (ctx) => {
    const v = attributeOf(ctx, attribute);
    return typeof v === "string" && test(v);
  };
}

function semverAgainst(
  attribute: string,
  target: Semver,
  sign: 1 | -1,
): CompiledCondition {
  return onString(attribute, (v) => {
    const parsed = parseSemver(v);
    return (
      parsed !== undefined && Math.sign(compareSemver(parsed, target)) === sign
    );
  });
}

/**
 * Biên dịch một điều kiện ĐÃ qua schema đọc. Ném chỉ khi dữ liệu mâu thuẫn với
 * chính schema đó (semver/regex hỏng) — `prepareSnapshot` bắt và đánh dấu rule
 * là hỏng.
 */
export function compileCondition(c: AttributeCondition): CompiledCondition {
  const { attribute } = c;
  switch (c.operator) {
    case "eq":
    case "neq": {
      const target = typeof c.value === "string" ? nfc(c.value) : c.value;
      const wantEqual = c.operator === "eq";
      return (ctx) => {
        const v = attributeOf(ctx, attribute);
        if (v === undefined || typeof v !== typeof target) return false;
        return (v === target) === wantEqual;
      };
    }
    case "in":
    case "nin": {
      const set = new Set(c.value.map(nfc));
      const wantMember = c.operator === "in";
      return onString(attribute, (v) => set.has(v) === wantMember);
    }
    case "gt":
      return compare(attribute, (v) => v > c.value);
    case "gte":
      return compare(attribute, (v) => v >= c.value);
    case "lt":
      return compare(attribute, (v) => v < c.value);
    case "lte":
      return compare(attribute, (v) => v <= c.value);
    case "contains": {
      const needle = nfc(c.value);
      return onString(attribute, (v) => v.includes(needle));
    }
    case "startsWith": {
      const needle = nfc(c.value);
      return onString(attribute, (v) => v.startsWith(needle));
    }
    case "endsWith": {
      const needle = nfc(c.value);
      return onString(attribute, (v) => v.endsWith(needle));
    }
    case "semverGt":
    case "semverLt": {
      const target = parseSemver(c.value);
      if (target === undefined) throw new Error("semver hỏng");
      return semverAgainst(
        attribute,
        target,
        c.operator === "semverGt" ? 1 : -1,
      );
    }
    case "regex": {
      // Biên dịch NGUYÊN VĂN: chuẩn hoá hộ đổi ngữ nghĩa pattern (xem
      // `regexSyntaxIssue`). Schema đọc đã từ chối pattern chưa ở dạng NFC.
      const re = new RegExp(c.value, "u");
      return onString(
        attribute,
        (v) => v.length <= CONDITION_LIMITS.regexInputMax && re.test(v),
      );
    }
  }
}
