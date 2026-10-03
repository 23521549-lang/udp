import { describe, expect, it } from "vitest";
import { flagRouter } from "../src/modules/flag/flag.controller.js";

/**
 * [v4.9] Thứ tự đăng ký route của `flagRouter` — khẳng định TĨNH, không HTTP,
 * không database (R29).
 *
 * Express khớp route theo thứ tự đăng ký, nên `GET /flags/stale` đặt SAU
 * `GET /flags/:flagId` sẽ bị nuốt: `uuidParam` trả 400 "Mã flag không hợp lệ" cho
 * một đường dẫn hoàn toàn đúng, và không test tích hợp nào của route ĐỘNG đỏ vì
 * chuyện đó. Thiết kế cảnh báo đúng cái bẫy này (design:1689).
 *
 * Luật viết dưới dạng TỔNG QUÁT — mọi đường dẫn tĩnh dưới `/flags/` phải đứng
 * trước `/flags/:flagId` — nên route tĩnh THÊM về sau cũng được canh, không chỉ
 * hai route của #23.
 */

interface RouteLayer {
  route?: { path: string; methods: Record<string, boolean> };
}

const routes = (flagRouter.stack as unknown as RouteLayer[]).flatMap((layer) =>
  layer.route === undefined
    ? []
    : [
        {
          path: layer.route.path,
          methods: Object.keys(layer.route.methods).sort(),
        },
      ],
);

const firstIndexOf = (path: string): number =>
  routes.findIndex((route) => route.path === path);

/** `/flags/<chữ>` — một đoạn, không có tham số */
const STATIC_CHILD = /^\/flags\/[a-z0-9-]+$/;

describe("thứ tự route của /flags (R29)", () => {
  it("hai route tĩnh của #23 có mặt, đúng method và đúng số lượng", () => {
    expect(routes.filter((route) => route.path === "/flags/stale")).toEqual([
      { path: "/flags/stale", methods: ["get"] },
    ]);
    expect(
      routes.filter((route) => route.path === "/flags/bulk-archive"),
    ).toEqual([{ path: "/flags/bulk-archive", methods: ["post"] }]);
    expect(firstIndexOf("/flags/:flagId")).toBeGreaterThanOrEqual(0);
  });

  it("MỌI đường dẫn tĩnh dưới /flags/ đăng ký TRƯỚC /flags/:flagId", () => {
    const dynamic = firstIndexOf("/flags/:flagId");
    const statics = routes
      .map((route, index) => ({ ...route, index }))
      .filter((route) => STATIC_CHILD.test(route.path));

    expect(statics.map((route) => route.path)).toEqual(
      expect.arrayContaining(["/flags/stale", "/flags/bulk-archive"]),
    );
    for (const route of statics) {
      expect(route.index).toBeLessThan(dynamic);
    }
  });

  it("route stats của flag nằm trên nhánh động, không phải nhánh tĩnh", () => {
    expect(firstIndexOf("/flags/:flagId/stats")).toBeGreaterThan(
      firstIndexOf("/flags/:flagId"),
    );
  });
});
