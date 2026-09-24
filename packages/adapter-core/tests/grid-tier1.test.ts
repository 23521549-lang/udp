import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { CloudAdapter } from "../src/cloud.js";
import { gridCell, type GridCell } from "../src/contract/grid.js";
import type { CloudContractEnv } from "../src/contract/index.js";
import {
  CLOUD_FIXTURE,
  CONSISTENCY_VARIANTS,
  CRASH_POINTS,
  FIXTURE_STEPS,
} from "../src/testing/fixture.js";
import { InMemoryLedger } from "../src/testing/in-memory-ledger.js";
import { createSimAdapter } from "../src/testing/sim-adapter.js";
import { SimCloud } from "../src/testing/sim-cloud.js";

/**
 * [v4.10] Lưới khôi phục — TẦNG 1 (in-process, `InMemoryLedger`).
 *
 * Tầng này chạy **tích chéo** điểm crash × step, nên nó bắt được lỗi phụ thuộc vị trí: một
 * runner đúng ở step đầu mà sai ở step có `dependsOn`, hay sai ở step cuối của một bước.
 * Bốn ô `child-only` (K3, K6, K9, K10) KHÔNG chạy ở đây — chúng khẳng định tính chất của sổ
 * bền hoặc của một tiến trình thật đã chết, và ở tầng này chúng sẽ xanh mà chứng minh một
 * thứ khác. Tầng 2 (P10) chạy chúng bằng tiến trình con `kill -9` thật trên `PrismaLedger`.
 *
 * Số ô của tầng này là một **tích ba hằng số**, và meta-test dưới cùng khẳng định con số đó:
 * "giảm số ô" khi ấy là một test đỏ, không phải một dòng biến mất trong diff.
 */

const BOTH_TIER = CRASH_POINTS.filter((c) => c.tier === "both");
const DELAYED = CONSISTENCY_VARIANTS.find((v) => v.name === "delayed");

/**
 * Chiều biến thể nhất quán CHỈ áp cho K2.
 *
 * Cửa sổ lan truyền tag có nghĩa ở đúng những ô mà runner phải quyết định "tạo hay không"
 * ngay sau khi ghi sổ. K3 là ô còn lại có nghĩa, nhưng nó `child-only`. Với các ô khác, biến
 * thể này nhân đôi thời gian mà không thêm tính chất nào — và một ô không thêm tính chất là
 * một ô làm người ta nghĩ bộ test mạnh hơn thực tế.
 */
const DELAYED_CRASH_IDS = ["K2"];

function envFor(): { env: CloudContractEnv; adapter: CloudAdapter; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "grid1-"));
  const cloud = new SimCloud({ statePath: join(dir, "cloud.json") });
  const adapter = createSimAdapter({ cloud, lookupBy: "tag" });
  const env: CloudContractEnv = {
    driver: "in-process",
    ledger: () => new InMemoryLedger(),
    control: cloud,
    fixture: CLOUD_FIXTURE,
  };
  return {
    env,
    adapter,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

/** Sinh lưới tầng 1 từ dữ liệu — không một ô nào viết tay */
function tier1Cells(): GridCell[] {
  const cells: GridCell[] = [];
  for (const crash of BOTH_TIER) {
    for (const spec of FIXTURE_STEPS) {
      cells.push(
        gridCell({
          crashId: crash.id,
          mode: crash.mode,
          phase: crash.phase,
          stepName: spec.name,
          variant: "instant",
          tagPropagationDelayMs: 0,
        }),
      );
      if (DELAYED_CRASH_IDS.includes(crash.id) && DELAYED !== undefined) {
        cells.push(
          gridCell({
            crashId: crash.id,
            mode: crash.mode,
            phase: crash.phase,
            stepName: spec.name,
            variant: "delayed",
            tagPropagationDelayMs: DELAYED.tagPropagationDelayMs,
          }),
        );
      }
    }
  }
  return cells;
}

const CELLS = tier1Cells();
let executed = 0;

describe("lưới khôi phục tầng 1", () => {
  for (const cell of CELLS) {
    it(cell.name, async () => {
      const { env, adapter, cleanup } = envFor();
      try {
        await cell.run(env, adapter);
        executed += 1;
      } finally {
        cleanup();
      }
    });
  }
});

/**
 * Ô `indeterminate` (K2b của §4.5) — chạy riêng vì nó không phải một điểm crash.
 *
 * Nó khẳng định bản sửa D-3': `lookup` trả `indeterminate` là một lỗi TẠM, nên runner cấm
 * `create()`, hàng giữ `CREATING`, và lượt sau hội tụ. Không có ô này thì bản sửa đó không
 * có gì bảo vệ, và một hiện thực quay về `ORPHAN_SUSPECTED` sẽ đi qua mọi ô khác.
 */
describe("ô indeterminate (K2b)", () => {
  it("cửa sổ lan truyền tag ⇒ KHÔNG tạo trùng, và lượt sau hội tụ", async () => {
    const { env, adapter, cleanup } = envFor();
    try {
      const ledger = env.ledger();
      const { runFullProvision } = await import("../src/contract/grid.js");
      const silent = { onPhase: (): void => undefined };

      /** Cửa sổ rộng hơn tổng backoff: mọi lần tra trong lượt này đều bất định */
      await env.control.setTagPropagationDelay(3_600_000);
      const first = await runFullProvision({ adapter, ledger, observer: silent });
      /**
       * Lượt đầu tạo `vpc` (chưa có gì nên `lookup` ra `absent`, không `indeterminate`),
       * rồi `subnet-a` tra không thấy `vpc`... nên điều cần khẳng định là: KHÔNG bao giờ có
       * nhiều hơn một tài nguyên cho cùng một khoá.
       */
      void first;

      await env.control.setTagPropagationDelay(0);
      const second = await runFullProvision({ adapter, ledger, observer: silent });
      expect(second.every((o) => o.status === "SUCCESS")).toBe(true);

      const rows = await ledger.rowsOf(
        "11111111-1111-4111-8111-111111111111",
      );
      expect(rows).toHaveLength(CLOUD_FIXTURE.expectedResourceCount);

      /** Không khoá nào có hai tài nguyên — tức không tạo trùng */
      const all = await env.control.listAll();
      const byKey = new Map<string, number>();
      for (const r of all) {
        const key = r.tags["udp.key"];
        if (key === undefined) continue;
        byKey.set(key, (byKey.get(key) ?? 0) + 1);
      }
      const duplicated = [...byKey.entries()].filter(([, n]) => n > 1);
      expect(duplicated).toEqual([]);
    } finally {
      cleanup();
    }
  });
});

/**
 * Meta-test: số ô là một tích ba hằng số, và mọi ô `child-only` VẮNG ở tầng này.
 *
 * Nói "ô ở tầng 1 của K9/K10 không được đếm" là chưa đủ — một ô luôn xanh vẫn tồn tại trong
 * bộ test và vẫn cho cảm giác an toàn. Ở đây `tier` là dữ liệu, nên sự vắng mặt của chúng
 * kiểm được.
 */
describe("meta — lưới tầng 1", () => {
  it("số ô = (số điểm crash tier=both) × số step + số ô biến thể delayed", () => {
    const expected =
      BOTH_TIER.length * FIXTURE_STEPS.length +
      DELAYED_CRASH_IDS.length * FIXTURE_STEPS.length;
    expect(CELLS).toHaveLength(expected);
  });

  it("KHÔNG ô nào của K3, K6, K9, K10 có mặt ở tầng 1", () => {
    const childOnly = CRASH_POINTS.filter((c) => c.tier === "child-only").map(
      (c) => c.id,
    );
    const leaked = CELLS.filter((c) => childOnly.includes(c.crashId));
    expect(leaked.map((c) => c.name)).toEqual([]);
  });

  it("sáu điểm crash tier=both đều có mặt, mỗi điểm đủ 13 step", () => {
    expect(BOTH_TIER).toHaveLength(6);
    for (const crash of BOTH_TIER) {
      const mine = CELLS.filter(
        (c) => c.crashId === crash.id && c.variant === "instant",
      );
      expect(mine, crash.id).toHaveLength(FIXTURE_STEPS.length);
    }
  });

  it("biến thể delayed chỉ áp cho K2, và nó có nghĩa ở đúng đó", () => {
    const delayedIds = [
      ...new Set(CELLS.filter((c) => c.variant === "delayed").map((c) => c.crashId)),
    ];
    expect(delayedIds).toEqual(DELAYED_CRASH_IDS);
  });

  /**
   * Chỉ có nghĩa ở một lượt chạy ĐẦY ĐỦ.
   *
   * Chạy với `-t` (lọc theo tên) thì các ô bị bỏ qua nên `executed` bằng 0 và phép này
   * đỏ vì lý do sai. Đó là cái giá đúng để trả: một phép đếm số ô đã chạy không thể vừa
   * chịu được bộ lọc vừa bắt được "một ô bị bỏ qua âm thầm".
   */
  it("mọi ô đã thực thi, không ô nào bị bỏ qua", () => {
    expect(executed).toBe(CELLS.length);
  });
});
