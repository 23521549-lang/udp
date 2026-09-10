/**
 * Gộp một địa chỉ IP thành KHÓA đếm cho rate limit.
 *
 * Ở `@udp/http` chứ không Ở một service, vì cả hai service đều cần đúng hàm này:
 * Service 1 giới hạn `/auth/*` theo IP, Service 2 giới hạn `/sdk/*` theo
 * `(sdk key, IP)` (§2.2 `RATE_LIMIT.sdk.perKeyIp`). Nhân bản thì hai bản sẽ trôi
 * khỏi nhau, mà trôi ở đây không lộ ra bằng lỗi: nó lộ ra bằng việc một bên vẫn
 * chặn được còn bên kia thì không. Còn để Service 2 import thẳng từ Service 1 là
 * phụ thuộc service → service, đúng thứ `package-boundaries.test.ts` sinh ra để chặn.
 *
 * Hàm THUẦN, không chạm Express: nhận chuỗi, trả chuỗi. Nhờ vậy nó kiểm được
 * bằng unit test trên hàng chục dạng địa chỉ thay vì phải dựng một server.
 *
 * `express-rate-limit@7.5.1` KHÔNG export `ipKeyGenerator` — đã kiểm file khai báo
 * kiểu — nên phải tự gộp.
 */
export function ipKey(raw: string): string {
  const ip = (raw.split("%")[0] ?? "").trim(); // bỏ zone id kiểu fe80::1%eth0
  if (!ip.includes(":")) return ip; // IPv4
  if (ip.startsWith("::ffff:")) return ip.slice("::ffff:".length); // IPv4 ánh xạ

  // Gộp về /64: phải KHAI TRIỂN dạng rút gọn trước, vì "2001:db8::1" chỉ có 4
  // đoạn khi split nhưng đoạn thứ tư là phần ĐUÔI của địa chỉ, không phải nhóm
  // thứ tư. Cắt thẳng bốn phần tử đầu sẽ cho ra một tiền tố sai.
  let groups: string[];
  if (ip.includes("::")) {
    const [head = "", tail = ""] = ip.split("::");
    const h = head === "" ? [] : head.split(":");
    const t = tail === "" ? [] : tail.split(":");
    groups = [
      ...h,
      ...Array<string>(Math.max(0, 8 - h.length - t.length)).fill("0"),
      ...t,
    ];
  } else {
    groups = ip.split(":");
  }

  return `${groups
    .slice(0, 4)
    .map((g) => (g === "" ? "0" : g))
    .join(":")}::/64`;
}
