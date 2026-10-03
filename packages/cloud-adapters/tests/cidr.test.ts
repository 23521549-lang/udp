import { describe, expect, it } from "vitest";
import { cidrsOverlap, hostAddress, subnetCidr } from "../src/core/cidr.js";

describe("chia khối CIDR", () => {
  it("bốn /20 liên tiếp trong một /16", () => {
    expect([0, 1, 2, 3].map((i) => subnetCidr("10.0.0.0/16", 20, i))).toEqual([
      "10.0.0.0/20",
      "10.0.16.0/20",
      "10.0.32.0/20",
      "10.0.48.0/20",
    ]);
  });

  it("khối gốc không thẳng hàng thì lấy địa chỉ mạng của nó", () => {
    expect(subnetCidr("172.16.5.9/16", 24, 1)).toBe("172.16.1.0/24");
  });

  it("chỉ số vượt số khối, cỡ con lớn hơn cha, hay CIDR sai ⇒ ném", () => {
    expect(() => subnetCidr("10.0.0.0/24", 26, 4)).toThrow();
    expect(() => subnetCidr("10.0.0.0/24", 16, 0)).toThrow();
    expect(() => subnetCidr("10.0.0.300/24", 26, 0)).toThrow();
  });
});

describe("chồng lấn và địa chỉ host", () => {
  it("khối chứa khối, trùng khối ⇒ chồng; khối rời ⇒ không", () => {
    expect(cidrsOverlap("10.0.0.0/16", "10.0.16.0/20")).toBe(true);
    expect(cidrsOverlap("10.0.16.0/20", "10.0.0.0/16")).toBe(true);
    expect(cidrsOverlap("192.168.0.0/16", "192.168.0.0/16")).toBe(true);
    expect(cidrsOverlap("10.0.0.0/16", "10.1.0.0/16")).toBe(false);
    expect(cidrsOverlap("172.20.0.0/16", "10.0.0.0/8")).toBe(false);
  });

  it("địa chỉ thứ n tính từ địa chỉ mạng; vượt khối ⇒ ném", () => {
    expect(hostAddress("172.20.0.0/16", 10)).toBe("172.20.0.10");
    expect(hostAddress("172.20.9.9/16", 10)).toBe("172.20.0.10");
    expect(() => hostAddress("10.0.0.0/30", 4)).toThrow();
  });
});
