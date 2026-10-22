import { TEST_IMAGES } from "@udp/config";
import { goldenPathFiles } from "@udp/golden-path";
import { describe, expect, it } from "vitest";

/**
 * [Plan #61 QĐ-8] Dockerfile Golden Path ghim image nền theo digest — và CÙNG digest với image test của pipeline,
 * nên test và image chạy trên một nền. Đổi một chỗ mà quên chỗ kia thì đỏ.
 */
describe("Dockerfile Golden Path ghim digest", () => {
  for (const [runtime, image] of [
    ["nodejs", TEST_IMAGES.nodejs],
    ["python", TEST_IMAGES.python],
  ] as const) {
    it(`${runtime}: mọi FROM là ${image.split("@")[0] ?? image} theo digest`, () => {
      const dockerfile = goldenPathFiles({
        runtime,
        slug: "web",
        registryRef: "ghcr.io/acme",
      }).find((f) => f.path === "Dockerfile");
      const froms = (dockerfile?.content ?? "")
        .split("\n")
        .filter((line) => line.startsWith("FROM "))
        .map((line) => line.split(" ")[1]);
      expect(froms.length).toBeGreaterThanOrEqual(2);
      for (const from of froms) expect(from).toBe(image);
    });
  }
});
