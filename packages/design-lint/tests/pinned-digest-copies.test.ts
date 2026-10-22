import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { BUILD_TOOLCHAIN, TEST_IMAGES } from "@udp/config/build-toolchain";
import { describe, expect, it } from "vitest";

/**
 * [Plan #61 61d-3c-2] Hai bản CHÉP CỨNG của ghim digest, và chúng chưa từng có cổng nào canh.
 *
 * `build-toolchain.ts` là nguồn duy nhất của ghim image, và `toolchain:check` canh nó hằng tuần. Nhưng hai chỗ
 * trong repo chép lại chính những digest đó mà **không** import từ đó:
 *
 *  1. `apps/portal/demo/mock/build.ts` — bảng `TEST_IMAGE` của bản xem thử. Không import được `@udp/config` vì gốc
 *     package đó re-export `env` và `env.ts` ném khi thiếu biến; thêm một dependency server-side vào app trình
 *     duyệt cũng là đi ngược ranh giới package. Nên bản chép là có chủ ý — và vì vậy nó cần một cổng.
 *  2. `tests/fixtures/build-apps/dockerfile/Dockerfile` — một Dockerfile không import được gì cả. Fixture này được
 *     **build thật** trong job `build-smoke` của CI, nên một digest lạc hậu ở đây là một lượt build khác hẳn lượt
 *     build mà pipeline của khách chạy.
 *
 * Thiếu cổng, một lượt `toolchain:check` nâng digest sẽ để hai chỗ này nói sai **trong im lặng**: bản xem thử hiện
 * một image khác bản thật, và fixture build trên một nền khác. Không test nào hôm nay đỏ vì chuyện đó.
 */

const REPO = resolve(import.meta.dirname, "../../..");

describe("bản chép cứng của ghim digest khớp BUILD_TOOLCHAIN", () => {
  it("bảng TEST_IMAGE của bản xem thử Portal bằng TEST_IMAGES", () => {
    const source = readFileSync(
      join(REPO, "apps/portal/demo/mock/build.ts"),
      "utf8",
    );
    const table = /const TEST_IMAGE: [^=]+=\s*\{([\s\S]*?)\n\};/.exec(source);
    expect(
      table,
      "không tìm thấy bảng TEST_IMAGE trong bản xem thử",
    ).not.toBeNull();

    const copied = Object.fromEntries(
      [
        ...(table?.[1] ?? "").matchAll(
          /"?([A-Za-z-]+)"?:\s*\n?\s*"([^"]+@sha256:[0-9a-f]{64})"/g,
        ),
      ].map((m) => [m[1] ?? "", m[2] ?? ""]),
    );

    /**
     * So CẢ HAI chiều: thiếu một ngôn ngữ cũng là lệch (bản xem thử sẽ không hiện image cho ngôn ngữ đó), và thêm
     * một ngôn ngữ lạ cũng là lệch (nó không có trong bảng thật nên không ai canh digest ấy).
     */
    expect(copied).toEqual({ ...TEST_IMAGES });
  });

  it("FROM của fixture Dockerfile bằng BUILD_TOOLCHAIN.images.alpine", () => {
    const dockerfile = readFileSync(
      join(
        REPO,
        "services/core-backend/tests/fixtures/build-apps/dockerfile/Dockerfile",
      ),
      "utf8",
    );
    const froms = [...dockerfile.matchAll(/^FROM\s+(\S+)/gim)].map(
      (m) => m[1] ?? "",
    );
    expect(froms.length).toBeGreaterThan(0);
    for (const from of froms) {
      expect(from).toBe(BUILD_TOOLCHAIN.images.alpine);
    }
  });
});
