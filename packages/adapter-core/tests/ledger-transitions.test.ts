import { describe, expect, it } from "vitest";
import {
  isLedgerTransitionAllowed,
  LEDGER_TRANSITIONS,
  PROVISIONED_RESOURCE_ROW_FIELDS,
  PROVISIONED_RESOURCE_ROW_OMITTED,
  type ProvisionedResourceRow,
  type ResourceStatus,
} from "../src/ledger.js";
import { TERMINAL_STATUSES } from "../src/runner/index.js";

/**
 * [v4.10] Máy trạng thái của sổ tài nguyên (§4.5).
 *
 * Hai tính chất được chốt ở đây là hai chỗ mà một hiện thực sai sẽ **xanh giả**:
 *
 *  - Thiếu cạnh `CREATING → DELETING` làm compensation một hàng chưa `READY` thành bất
 *    hợp pháp. Bản v4.9 đúng là thiếu nó, và ca đó là ca thường xuyên nhất sau crash.
 *  - `ORPHAN_SUSPECTED` nhận cạnh vào từ một lỗi TẠM (ví dụ `lookup` trả `indeterminate`)
 *    làm một blip lan truyền tag khoá step vĩnh viễn, vì trạng thái đó không có cạnh ra.
 */

const ALL: readonly (ResourceStatus | "ABSENT")[] = [
  "ABSENT",
  "CREATING",
  "CREATED",
  "READY",
  "DELETING",
  "DELETED",
  "ORPHAN_SUSPECTED",
];

describe("LEDGER_TRANSITIONS", () => {
  it("đúng chín cạnh, không trùng", () => {
    expect(LEDGER_TRANSITIONS).toHaveLength(9);
    const keys = LEDGER_TRANSITIONS.map(([a, b]) => `${a}->${b}`);
    expect(new Set(keys).size).toBe(9);
  });

  it("có hai cạnh compensation của v4.10", () => {
    expect(isLedgerTransitionAllowed("CREATING", "DELETING")).toBe(true);
    expect(isLedgerTransitionAllowed("CREATED", "DELETING")).toBe(true);
  });

  it("giữ đủ bảy cạnh của v4.9", () => {
    for (const [from, to] of [
      ["ABSENT", "CREATING"],
      ["CREATING", "CREATED"],
      ["CREATED", "READY"],
      ["READY", "DELETING"],
      ["DELETING", "DELETED"],
      ["DELETING", "ORPHAN_SUSPECTED"],
      ["CREATING", "ORPHAN_SUSPECTED"],
    ] as const) {
      expect(isLedgerTransitionAllowed(from, to), `${from}->${to}`).toBe(true);
    }
  });

  /**
   * `ORPHAN_SUSPECTED` là trạng thái cần người xem, không phải một trạng thái cuối im
   * lặng — nhưng nó cũng không có đường tự thoát. Nếu một hiện thực thêm cạnh ra khỏi
   * nó, `GET /admin/orphan-resources` sẽ mất hàng mà không ai biết.
   */
  it("ORPHAN_SUSPECTED không có cạnh ra", () => {
    const out = LEDGER_TRANSITIONS.filter(
      ([from]) => from === "ORPHAN_SUSPECTED",
    );
    expect(out).toHaveLength(0);
  });

  it("DELETED là trạng thái cuối", () => {
    expect(
      LEDGER_TRANSITIONS.filter(([from]) => from === "DELETED"),
    ).toHaveLength(0);
  });

  it("không có cạnh nào quay về ABSENT", () => {
    expect(
      LEDGER_TRANSITIONS.filter(([, to]) => (to as string) === "ABSENT"),
    ).toHaveLength(0);
  });

  /**
   * Chốt chiều ÂM: mọi cặp không nằm trong chín cạnh phải bị từ chối. Một hiện thực
   * `isLedgerTransitionAllowed` trả `true` mặc định sẽ xanh với mọi ô dương ở trên.
   */
  it("từ chối MỌI cặp không nằm trong chín cạnh", () => {
    const allowed = new Set(LEDGER_TRANSITIONS.map(([a, b]) => `${a}->${b}`));
    let rejected = 0;
    const destinations = ALL.filter((s): s is ResourceStatus => s !== "ABSENT");
    for (const from of ALL) {
      for (const to of destinations) {
        const key = `${from}->${to}`;
        if (allowed.has(key)) continue;
        expect(isLedgerTransitionAllowed(from, to), key).toBe(false);
        rejected += 1;
      }
    }
    // 7 trang thai nguon × 6 dich (bo ABSENT) = 42 cap, tru 9 canh hop le
    expect(rejected).toBe(42 - 9);
  });
});

describe("TERMINAL_STATUSES — hai trạng thái I31 đòi hội tụ về", () => {
  it("đúng READY và DELETED", () => {
    expect([...TERMINAL_STATUSES].sort()).toEqual(["DELETED", "READY"]);
  });

  it("ORPHAN_SUSPECTED KHÔNG phải trạng thái hội tụ", () => {
    expect(TERMINAL_STATUSES).not.toContain("ORPHAN_SUSPECTED");
  });
});

describe("ProvisionedResourceRow", () => {
  it("tám trường, khớp danh sách chạy được", () => {
    const row: ProvisionedResourceRow = {
      projectId: "p",
      step: "NETWORK",
      kind: "vpc",
      idempotencyKey: "p:NETWORK:vpc:vpc",
      providerId: null,
      provider: "aws",
      region: "ap-southeast-1",
      status: "CREATING",
    };
    expect(Object.keys(row).sort()).toEqual(
      [...PROVISIONED_RESOURCE_ROW_FIELDS].sort(),
    );
  });

  /**
   * `job_id` phải nằm trong danh sách CỐ TÌNH BỎ.
   *
   * ADR-08 nói mọi cột suy ra được từ tag trừ `job_id`. Nếu ai đó thêm nó vào DTO thì
   * `rebuildLedgerFromCloud` sẽ phải bịa một giá trị, và lịch sử mất một cách không
   * nhìn thấy được — đúng thứ mà việc tách K10a/K10b sinh ra để tránh.
   */
  it("job_id nằm trong danh sách cố tình bỏ", () => {
    expect(PROVISIONED_RESOURCE_ROW_OMITTED).toContain("job_id");
    expect(PROVISIONED_RESOURCE_ROW_FIELDS).not.toContain("jobId");
  });

  /** `managedByK8s` là kết quả phát hiện từ cloud; trong SỔ nó là `step` */
  it("KHÔNG mang managedByK8s — trong sổ tính chất đó là step", () => {
    expect(PROVISIONED_RESOURCE_ROW_FIELDS).not.toContain("managedByK8s");
    expect(PROVISIONED_RESOURCE_ROW_FIELDS).toContain("step");
  });
});
