import { z, type ZodTypeAny } from "zod";
import type { DomainConfigFieldWire } from "@udp/shared-types/wire";
import { isSecretField } from "./tool-secrets.js";

/**
 * `configSchema` của adapter ⇒ mô tả trường cho form của Portal (Plan #27 QĐ-3).
 *
 * Portal không có danh sách trường cứng nào (§5.3 "thêm adapter = 0 file UI"): form dựng từ
 * mô tả này, và lúc lưu Service 1 parse bằng CHÍNH `configSchema` — mô tả chỉ để vẽ, không
 * để kiểm. Kiểu không biết vẽ (object lồng, mảng, union…) thành `json`: một ô JSON vẫn
 * nhập được, còn bỏ im một trường là để người dùng không bao giờ đặt được nó.
 */

export type ConfigDescription =
  { kind: "object"; fields: DomainConfigFieldWire[] } | { kind: "json" };

interface Unwrapped {
  inner: ZodTypeAny;
  required: boolean;
  defaultValue: unknown;
}

/**
 * Bóc `optional` / `nullable` / `default` / `refine` (theo bất kỳ thứ tự nào) để thấy kiểu lõi.
 *
 * `refine` (hiệu ứng loại `refinement`) không đổi kiểu ĐẦU VÀO — ô nhập vẫn là chuỗi, luật thêm
 * vẫn do `configSchema` kiểm lúc lưu. `transform`/`preprocess` thì đổi kiểu, nên không bóc: vẽ
 * theo kiểu lõi của chúng là vẽ sai ô.
 */
function unwrap(schema: ZodTypeAny): Unwrapped {
  let inner = schema;
  let required = true;
  let defaultValue: unknown = undefined;
  for (;;) {
    if (inner instanceof z.ZodOptional || inner instanceof z.ZodNullable) {
      required = false;
      inner = inner.unwrap() as ZodTypeAny;
    } else if (inner instanceof z.ZodDefault) {
      required = false;
      defaultValue = (
        inner._def as { defaultValue: () => unknown }
      ).defaultValue();
      inner = inner.removeDefault() as ZodTypeAny;
    } else if (
      inner instanceof z.ZodEffects &&
      (inner._def as { effect: { type: string } }).effect.type === "refinement"
    ) {
      inner = inner.innerType() as ZodTypeAny;
    } else {
      return { inner, required, defaultValue };
    }
  }
}

const isScalar = (v: unknown): v is string | number | boolean =>
  typeof v === "string" || typeof v === "number" || typeof v === "boolean";

function numberBounds(schema: z.ZodNumber): {
  min?: number;
  max?: number;
  integer: boolean;
} {
  const out: { min?: number; max?: number; integer: boolean } = {
    integer: false,
  };
  for (const check of schema._def.checks) {
    if (check.kind === "min") out.min = check.value;
    if (check.kind === "max") out.max = check.value;
    if (check.kind === "int") out.integer = true;
  }
  return out;
}

function fieldOf(key: string, schema: ZodTypeAny): DomainConfigFieldWire {
  const { inner, required, defaultValue } = unwrap(schema);
  const base = {
    key,
    required,
    // Bí mật (Plan #31): Portal vẽ ô mật khẩu và không bao giờ nhận lại giá trị
    ...(isSecretField(schema) ? { secret: true } : {}),
    ...(isScalar(defaultValue) ? { default: defaultValue } : {}),
  };
  if (inner instanceof z.ZodString) return { ...base, kind: "string" };
  if (inner instanceof z.ZodBoolean) return { ...base, kind: "boolean" };
  if (inner instanceof z.ZodEnum) {
    return { ...base, kind: "enum", options: [...(inner.options as string[])] };
  }
  if (inner instanceof z.ZodNumber) {
    return { ...base, kind: "number", ...numberBounds(inner) };
  }
  return { key, required, kind: "json" };
}

export function describeConfigSchema(schema: ZodTypeAny): ConfigDescription {
  const { inner } = unwrap(schema);
  if (!(inner instanceof z.ZodObject)) return { kind: "json" };
  const shape = inner.shape as Record<string, ZodTypeAny>;
  return {
    kind: "object",
    fields: Object.entries(shape).map(([key, field]) => fieldOf(key, field)),
  };
}
