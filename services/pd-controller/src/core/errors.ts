/**
 * Chuỗi mô tả một giá trị bị ném — không phải mọi thứ bị `reject` là `Error`.
 * Một chuỗi HOLD trong `last_decision` ghi "undefined" vì `(err as Error).message`
 * là thứ người vận hành không dùng được.
 */
export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}
