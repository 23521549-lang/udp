import { describe, expect, it } from "vitest";
import { ipKey } from "../src/core/http/middlewares/rate-limit.middleware.js";

/**
 * Gộp IPv6 về /64 — thứ dễ viết sai nhất trong cả middleware.
 *
 * Nhà mạng cấp cho một thuê bao cả dải /64. Đếm rate limit theo địa chỉ đầy đủ
 * nghĩa là kẻ tấn công có 18 tỷ tỷ bucket miễn phí, không cần giả mạo header
 * nào. Nhưng cắt bốn nhóm đầu một cách ngây thơ thì sai với dạng rút gọn `::`:
 * `2001:db8::1` chỉ có bốn đoạn khi split, và đoạn thứ tư là phần ĐUÔI.
 */
describe("ipKey", () => {
  it("IPv4 giữ nguyên", () => {
    expect(ipKey("203.0.113.7")).toBe("203.0.113.7");
  });

  it("IPv4 ánh xạ vào IPv6 trả về dạng IPv4", () => {
    expect(ipKey("::ffff:203.0.113.7")).toBe("203.0.113.7");
  });

  it("IPv6 đầy đủ gộp về bốn nhóm đầu", () => {
    expect(ipKey("2001:0db8:85a3:0000:1111:2222:3333:4444")).toBe(
      "2001:0db8:85a3:0000::/64",
    );
  });

  it("IPv6 rút gọn được KHAI TRIỂN trước khi cắt", () => {
    // Nếu cắt thẳng bốn đoạn của "2001:db8::1" sẽ ra "2001:db8::1" — tức là
    // không gộp gì cả, và mỗi địa chỉ trong /64 vẫn là một bucket riêng.
    expect(ipKey("2001:db8::1")).toBe("2001:db8:0:0::/64");
    expect(ipKey("2001:db8:1:2:3:4:5:6")).toBe("2001:db8:1:2::/64");
  });

  it("mọi địa chỉ trong cùng /64 cho CÙNG một khoá", () => {
    const keys = new Set(
      [
        "2001:db8:abcd:1234::1",
        "2001:db8:abcd:1234::2",
        "2001:db8:abcd:1234:ffff:ffff:ffff:ffff",
      ].map(ipKey),
    );
    expect(keys.size).toBe(1);
  });

  it("hai /64 khác nhau cho hai khoá khác nhau", () => {
    expect(ipKey("2001:db8:abcd:1234::1")).not.toBe(
      ipKey("2001:db8:abcd:1235::1"),
    );
  });

  it("bỏ zone id", () => {
    expect(ipKey("fe80::1%eth0")).toBe("fe80:0:0:0::/64");
  });
});
