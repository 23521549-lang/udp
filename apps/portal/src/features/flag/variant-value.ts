import type { CreateFlagFields } from "@udp/shared-types/flag-api";

type FlagType = CreateFlagFields["flagType"];

/**
 * Ô nhập giá trị variant là chữ; kiểu thật theo `flagType`. Chữ không đọc được thành số hay JSON
 * được gửi NGUYÊN chữ: máy chủ kiểm bằng `FLAG_VALUE_SCHEMAS` và trả lỗi có tên variant — Portal
 * không đoán thay.
 */
export function parseVariantValue(type: FlagType, text: string): unknown {
  if (type === "NUMBER") return text.trim() === "" ? text : Number(text);
  if (type === "JSON") {
    try {
      return JSON.parse(text) as unknown;
    } catch {
      return text;
    }
  }
  return text;
}

/** Chiều ngược của `parseVariantValue` — giá trị đang lưu hiện lại trong ô nhập */
export function formatVariantValue(type: FlagType, value: unknown): string {
  if (type === "JSON") return JSON.stringify(value);
  return typeof value === "string" ? value : String(value);
}
