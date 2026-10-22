import type { ReadOnlyAdapterContext } from "@udp/adapter-core";

/**
 * Tên cluster mà agent của nhà cung cấp (New Relic, Dynatrace, Grafana Cloud) gắn lên MỌI dữ
 * liệu nó gửi đi — một tài khoản phục vụ nhiều cluster phải phân biệt được chúng.
 *
 * Suy từ tag `udp.project` mà mọi lời gọi adapter của sản phẩm đều mang (§4.4), không từ
 * cấu hình người dùng: hai project gõ cùng một tên sẽ trộn dữ liệu của nhau trong một tài
 * khoản. NÉM khi thiếu tag — cùng luật "không đoán" với binding thiếu (§5.2).
 */
export function agentClusterName(ctx: ReadOnlyAdapterContext): string {
  const project = ctx.tags["udp.project"];
  if (project === undefined || project === "") {
    throw new Error("thiếu tag udp.project trong ctx.tags");
  }
  return `udp-${project}`;
}
