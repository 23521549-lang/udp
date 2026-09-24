import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  CLOUD_FIXTURE,
  CONSISTENCY_VARIANTS,
  CRASH_POINTS,
  EXPECTED_BY_KIND,
  EXPECTED_RESOURCE_COUNT,
  EXPECTED_STEP_COUNT,
  FIXTURE_STEPS,
  K10_VARIANTS,
} from "../src/testing/fixture.js";

/**
 * [v4.10] Hằng số kỳ vọng, và **cổng thứ tự thứ ba** của plan.
 *
 * Ba ràng buộc thứ tự của Plan #24 không hồi phục được nếu làm sai, và cái này là một
 * trong ba: hằng số kỳ vọng phải commit **trước** `steps` của adapter sim. Nếu làm ngược,
 * số kỳ vọng gần như chắc chắn được viết bằng cách chạy adapter rồi chép kết quả — tức
 * một tautology — và `git log` là bằng chứng duy nhất phân biệt hai trường hợp đó, nên nó
 * không sửa lại được bằng cách viết lại hằng số sau.
 */

const here = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(here, "../../..");

const FIXTURE_FILE = "packages/adapter-core/src/testing/fixture.ts";
/** Nơi adapter sim sẽ sống (P7). Chưa tồn tại ở pha này — xem phép kiểm cuối */
const SIM_ADAPTER_FILE = "packages/adapter-core/src/testing/sim-adapter.ts";

function firstCommitOf(path: string): string | null {
  try {
    const out = execFileSync(
      "git",
      ["log", "--diff-filter=A", "--format=%H", "--", path],
      { cwd: REPO, encoding: "utf8" },
    ).trim();
    const lines = out.split("\n").filter((l) => l.length > 0);
    return lines.at(-1) ?? null;
  } catch {
    return null;
  }
}

function isAncestor(a: string, b: string): boolean {
  try {
    execFileSync("git", ["merge-base", "--is-ancestor", a, b], { cwd: REPO });
    return true;
  } catch {
    return false;
  }
}

describe("FIXTURE_STEPS và các hằng số kỳ vọng", () => {
  it("mười ba step, tên không trùng", () => {
    expect(FIXTURE_STEPS).toHaveLength(13);
    expect(new Set(FIXTURE_STEPS.map((s) => s.name)).size).toBe(13);
  });

  /**
   * `EXPECTED_STEP_COUNT` là hằng số RIÊNG, và phép kiểm này đối chiếu nó với danh sách.
   * Viết `FIXTURE_STEPS.length` ở chỗ dùng thì fixture tụt từ 13 xuống 1 vẫn xanh.
   */
  it("EXPECTED_STEP_COUNT khớp danh sách", () => {
    expect(EXPECTED_STEP_COUNT).toBe(FIXTURE_STEPS.length);
  });

  it("bảng kind khớp tổng số, và tổng khớp EXPECTED_RESOURCE_COUNT", () => {
    const sum = Object.values(EXPECTED_BY_KIND).reduce((a, b) => a + b, 0);
    expect(sum).toBe(EXPECTED_RESOURCE_COUNT);
    expect(sum).toBe(FIXTURE_STEPS.length);
  });

  /**
   * Chỉ một tổng số thì bỏ một `subnet` và thêm một `addon` vẫn ra 13. Đối chiếu theo
   * từng `kind` làm mỗi step biến mất là một test đỏ.
   */
  it("bảng kind khớp FIXTURE_STEPS theo TỪNG kind", () => {
    const counted = new Map<string, number>();
    for (const s of FIXTURE_STEPS) {
      counted.set(s.kind, (counted.get(s.kind) ?? 0) + 1);
    }
    expect(Object.fromEntries([...counted.entries()].sort())).toEqual(
      Object.fromEntries(Object.entries(EXPECTED_BY_KIND).sort()),
    );
  });

  it("mọi dependsOn trỏ tới một step ĐỨNG TRƯỚC — đây là hợp đồng của prior", () => {
    const seen = new Set<string>();
    for (const s of FIXTURE_STEPS) {
      if (s.dependsOn !== undefined) {
        expect(seen, `${s.name} phụ thuộc ${s.dependsOn}`).toContain(
          s.dependsOn,
        );
      }
      seen.add(s.name);
    }
  });

  it("có đúng một step dùng kind KHÔNG gắn được tag lúc tạo", () => {
    expect(FIXTURE_STEPS.filter((s) => s.kind === "route-table")).toHaveLength(
      1,
    );
  });

  it("CLOUD_FIXTURE gom đúng ba hằng số", () => {
    expect(CLOUD_FIXTURE.expectedStepCount).toBe(EXPECTED_STEP_COUNT);
    expect(CLOUD_FIXTURE.expectedResourceCount).toBe(EXPECTED_RESOURCE_COUNT);
    expect(CLOUD_FIXTURE.expectedByKind).toBe(EXPECTED_BY_KIND);
  });
});

describe("CRASH_POINTS — tier là DỮ LIỆU", () => {
  it("mười điểm, id không trùng, khớp K1..K10", () => {
    expect(CRASH_POINTS).toHaveLength(10);
    expect(CRASH_POINTS.map((c) => c.id)).toEqual([
      "K1",
      "K2",
      "K3",
      "K4",
      "K5",
      "K6",
      "K7",
      "K8",
      "K9",
      "K10",
    ]);
  });

  /**
   * Bốn ô này là những ô mà tính chất cần khẳng định là tính chất của **sổ bền** hay của
   * **một tiến trình thật đã chết**. Chạy chúng in-process với sổ trong bộ nhớ là một ô
   * rỗng nghĩa, nên chúng không được có mặt ở tầng 1.
   */
  it("K3, K6, K9, K10 là child-only", () => {
    const childOnly = CRASH_POINTS.filter((c) => c.tier === "child-only").map(
      (c) => c.id,
    );
    expect(childOnly.sort()).toEqual(["K10", "K3", "K6", "K9"]);
  });

  it("mọi điểm crash đều nêu LÝ DO, không phải một nhãn trống", () => {
    for (const c of CRASH_POINTS) {
      expect(c.why.length, c.id).toBeGreaterThan(30);
      expect(c.phase.length, c.id).toBeGreaterThan(3);
    }
  });

  it("K10 có đúng hai biến thể, vì job_id không suy ra được từ tag", () => {
    expect(K10_VARIANTS).toHaveLength(2);
    expect(K10_VARIANTS.map((v) => v.id)).toEqual(["K10a", "K10b"]);
  });

  it("CONSISTENCY_VARIANTS có đúng hai, một tức thì và một có độ trễ", () => {
    expect(CONSISTENCY_VARIANTS).toHaveLength(2);
    expect(CONSISTENCY_VARIANTS.map((v) => v.name)).toEqual([
      "instant",
      "delayed",
    ]);
    expect(CONSISTENCY_VARIANTS[1]?.tagPropagationDelayMs).toBeGreaterThan(0);
  });
});

describe("cổng thứ tự — hằng số kỳ vọng commit TRƯỚC steps của adapter", () => {
  /**
   * Ba trạng thái, và phép kiểm nói ra được cả ba.
   *
   * Bản đầu chỉ xử lý hai ("chưa tạo" và "đã commit") nên nó ĐỎ ở trạng thái thứ ba — file
   * vừa được viết trong pha này, chưa commit. Đỏ ở đó là đúng hướng nhưng sai thông điệp:
   * nó nói "file không được tồn tại", trong khi điều cần khẳng định là thứ tự SẼ đúng khi
   * commit.
   *
   * | Trạng thái | Khẳng định |
   * | --- | --- |
   * | chưa tạo | file không tồn tại — nói ra trạng thái, không im lặng `return` |
   * | đã tạo, chưa commit | hằng số **đã** vào lịch sử, nên khi adapter được commit thì thứ tự tất yếu đúng |
   * | đã commit | commit hằng số là **tổ tiên** của commit adapter, và hai commit khác nhau |
   */
  it("thứ tự hằng số → adapter đúng ở cả ba trạng thái của lịch sử", () => {
    const fixtureCommit = firstCommitOf(FIXTURE_FILE);
    const adapterCommit = firstCommitOf(SIM_ADAPTER_FILE);
    const adapterExists = existsSync(resolve(REPO, SIM_ADAPTER_FILE));

    if (adapterCommit === null && !adapterExists) {
      expect(adapterExists).toBe(false);
      return;
    }

    if (adapterCommit === null) {
      expect(
        fixtureCommit,
        "adapter sim đã được viết nhưng hằng số kỳ vọng CHƯA vào lịch sử: " +
          "commit theo thứ tự này thì không còn bằng chứng nào cho thứ tự ngược lại",
      ).not.toBeNull();
      return;
    }

    expect(fixtureCommit).not.toBeNull();
    expect(
      isAncestor(fixtureCommit as string, adapterCommit),
      "hằng số kỳ vọng phải là tổ tiên của commit thêm adapter sim: " +
        "viết số kỳ vọng SAU khi có adapter gần như chắc chắn là chép kết quả của nó",
    ).toBe(true);
    expect(fixtureCommit).not.toBe(adapterCommit);
  });
});
