/**
 * Gộp hai merge patch thành MỘT (Plan #51 QĐ-7): strategy của session và image mới đi cùng một lần ghi có điều
 * kiện `resourceVersion` — hai lần ghi thì Argo có thể thấy image mới dưới strategy CŨ trong khoảng giữa. Object
 * gộp đệ quy; giá trị khác (mảng, số, `null`) của patch sau thắng.
 */
type Json = Record<string, unknown>;

const isObject = (v: unknown): v is Json =>
  typeof v === "object" && v !== null && !Array.isArray(v);

export function mergePatches(a: Json, b: Json): Json {
  const out: Json = { ...a };
  for (const [key, value] of Object.entries(b)) {
    const current = out[key];
    out[key] =
      isObject(current) && isObject(value)
        ? mergePatches(current, value)
        : value;
  }
  return out;
}

/**
 * Merge patch biến `current` thành `target` (Plan #51 QĐ-10): khoá có ở `current` mà không có ở `target` ⇒ `null`
 * (xoá); object ở cả hai ⇒ đệ quy; còn lại lấy giá trị của `target`. Dùng để trả `spec.strategy` của một `Rollout`
 * về bản gốc sau session UDP — gửi thẳng bản gốc là GỘP vào strategy của session, để lại `blueGreen` hay `steps`
 * của nó.
 */
export function patchToward(current: Json, target: Json): Json {
  const out: Json = {};
  for (const key of Object.keys(current)) {
    if (!(key in target)) out[key] = null;
  }
  for (const [key, value] of Object.entries(target)) {
    const now = current[key];
    out[key] =
      isObject(now) && isObject(value) ? patchToward(now, value) : value;
  }
  return out;
}
