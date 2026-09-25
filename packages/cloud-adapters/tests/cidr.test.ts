import { describe, expect, it } from "vitest";
import { subnetCidr } from "../src/core/cidr.js";

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
