import { CONDITION_LIMITS, SEGMENT } from "@udp/config";
import { canonicalJson, configHashOf } from "@udp/flag-evaluator";
import { describe, expect, it } from "vitest";
import {
  segmentPayloadBytesOf,
  segmentStateFor,
  snapshotFromRow,
  stateFor,
  unchangedStateOf,
} from "../src/snapshot-builder.js";
import type { SnapshotReader, SnapshotRow } from "../src/snapshot-row.js";

/**
 * [v4.9] Ba helper của bước 3–4 mà đường ghi segment và đường thu hồi SDK key
 * dùng (§3.5, V21, L1) — thuần, không database.
 *
 * `snapshotOf` bên dưới chúng là MỘT câu `$queryRaw` đã validate, và câu đó có
 * lớp golden hash riêng ở `snapshot-row.test.ts`. Ở đây thay nó bằng một reader
 * giả, để phần được kiểm đúng là phần mà file này quyết định: hình dạng payload
 * outbox, và hash đi kèm nó.
 */

const SEG_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const SEG_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const ENV = "11111111-1111-4111-8111-111111111111";
const ENV_2 = "22222222-2222-4222-8222-222222222222";

const row = (
  segments: SnapshotRow["segments"] = [],
): SnapshotRow & Record<string, unknown> => ({
  name: "dev",
  configVersion: 7,
  configHash: "khong-doc-toi",
  segments,
  flags: [],
  trackedFlags: [],
});

/** Reader giả: đúng một hàng, như `snapshotRowOf` mong đợi */
const readerOf = (result: SnapshotRow): SnapshotReader => ({
  $queryRaw: (() => Promise.resolve([result])) as SnapshotReader["$queryRaw"],
});

/**
 * [v4.10] Reader giả CÓ GHI LẠI câu lệnh, và giả đúng hành vi của Postgres: câu
 * lệnh không có subquery segment thì cột `segments` về rỗng. Nếu việc dùng lại
 * danh sách bị hỏng, hàng thứ hai sẽ mất segment — và hash đổi ngay.
 */
const recordingReader = (
  segments: SnapshotRow["segments"],
): { reader: SnapshotReader; statements: string[] } => {
  const statements: string[] = [];
  const $queryRaw = (query: { sql: string }): Promise<unknown[]> => {
    statements.push(query.sql);
    return Promise.resolve([
      query.sql.includes("FROM segments") ? row(segments) : row([]),
    ]);
  };
  return {
    statements,
    reader: { $queryRaw: $queryRaw as unknown as SnapshotReader["$queryRaw"] },
  };
};

describe("segmentStateFor — payload outbox của segment.updated (§3.5)", () => {
  it("segment CÓ trong snapshot ⇒ { segment }, và hash là hash của snapshot đó", async () => {
    const seg = {
      id: SEG_A,
      conditions: { all: [] as unknown[], userIds: ["u2", "u1"] },
    };
    const snapshotRow = row([seg]);
    const state = await segmentStateFor(SEG_A)(readerOf(snapshotRow), ENV);

    expect(state.delta).toEqual({
      // `userIds` đã sắp ở builder, nên payload lên dây trùng thứ tự trong hash
      segment: { id: SEG_A, all: [], userIds: ["u1", "u2"] },
    });
    expect(state.configHash).toBe(configHashOf(snapshotFromRow(snapshotRow)));
  });

  it("segment VẮNG khỏi snapshot (đã xoá) ⇒ { absentSegmentId }", async () => {
    const snapshotRow = row([
      { id: SEG_B, conditions: { all: [], userIds: [] } },
    ]);
    const state = await segmentStateFor(SEG_A)(readerOf(snapshotRow), ENV);

    expect(state.delta).toEqual({ absentSegmentId: SEG_A });
    expect(state.configHash).toBe(configHashOf(snapshotFromRow(snapshotRow)));
  });
});

describe("unchangedStateOf — sdkkey.revoked (L1)", () => {
  it("giữ nguyên payload bên gọi đưa, và TÍNH LẠI hash của snapshot", async () => {
    const snapshotRow = row([
      { id: SEG_A, conditions: { all: [], userIds: ["u1"] } },
    ]);
    const sdkKeyId = "9d2f4c1e-0000-4000-8000-000000000001";
    const state = await unchangedStateOf({ sdkKeyId })(
      readerOf(snapshotRow),
      ENV,
    );

    expect(state.delta).toEqual({ sdkKeyId });
    /**
     * Con số này TRÙNG hash đang lưu ở `environments` — và chính sự trùng đó là
     * tín hiệu hub SSE dùng để gửi `flag_changed` rỗng thay cho snapshot (L1).
     */
    expect(state.configHash).toBe(configHashOf(snapshotFromRow(snapshotRow)));
  });
});

describe("[v4.10] segments đọc MỘT lần cho cả lần ghi fan-out", () => {
  const seg = {
    id: SEG_A,
    conditions: { all: [] as unknown[], userIds: ["u2", "u1"] },
  };

  it("environment thứ hai KHÔNG đọc lại segments, mà hash và delta không đổi", async () => {
    const { reader, statements } = recordingReader([seg]);
    const stateOf = segmentStateFor(SEG_A);

    const first = await stateOf(reader, ENV);
    const second = await stateOf(reader, ENV_2);

    expect(statements).toHaveLength(2);
    expect(statements[0]).toContain("FROM segments");
    expect(statements[1]).not.toContain("FROM segments");
    // Cùng từng bit: cùng hash, cùng payload — I15c không bị chạm
    expect(second).toEqual(first);
    expect(first.configHash).toBe(configHashOf(snapshotFromRow(row([seg]))));
  });

  it("cả ba hàm dựng stateOf đều dùng lại, và bộ đệm sống đúng bằng MỘT lần ghi", async () => {
    const factories: Record<
      string,
      (tx: SnapshotReader, environmentId: string) => Promise<unknown>
    > = {
      stateFor: stateFor("khong-co-flag-nay"),
      segmentStateFor: segmentStateFor(SEG_A),
      unchangedStateOf: unchangedStateOf({ sdkKeyId: SEG_B }),
    };

    for (const [name, stateOf] of Object.entries(factories)) {
      const { reader, statements } = recordingReader([seg]);
      const first = await stateOf(reader, ENV);
      const second = await stateOf(reader, ENV_2);

      expect(
        statements.filter((s) => s.includes("FROM segments")),
        name,
      ).toHaveLength(1);
      expect(second, name).toEqual(first);
    }

    // Một lần ghi khác ⇒ một `stateOf` khác ⇒ đọc lại từ đầu
    const { reader, statements } = recordingReader([seg]);
    await segmentStateFor(SEG_A)(reader, ENV);
    await segmentStateFor(SEG_A)(reader, ENV_2);
    expect(statements.filter((s) => s.includes("FROM segments"))).toHaveLength(
      2,
    );
  });
});

describe("segmentPayloadBytesOf — trần dung lượng theo project (V21)", () => {
  it("đo trên canonical JSON UTF-8 của { all, userIds }", () => {
    const conditions = { all: [], userIds: ["u1", "u2"] };
    expect(segmentPayloadBytesOf(conditions)).toBe(
      Buffer.byteLength(canonicalJson(conditions), "utf8"),
    );
    // Vỏ rỗng: `{"all":[],"userIds":[]}`
    expect(segmentPayloadBytesOf({ all: [], userIds: [] })).toBe(23);
  });

  it("ký tự nhiều byte đếm theo BYTE, không theo ký tự", () => {
    const ascii = segmentPayloadBytesOf({ all: [], userIds: ["abc"] });
    const bmp = segmentPayloadBytesOf({ all: [], userIds: ["Việt"] });
    // "abc" = 3 byte + 2 nháy
    expect(ascii).toBe(23 + 5);
    // "Việt" = 4 ký tự nhưng 6 byte UTF-8 (ệ là 3 byte), + 2 nháy
    expect(bmp).toBe(23 + 8);
  });

  it("segment ASCII lớn nhất theo trần TỪNG segment vừa trần project (§2.1)", () => {
    const userId = "u".repeat(CONDITION_LIMITS.userIdMaxLength);
    const userIds = Array.from(
      { length: CONDITION_LIMITS.userIdsMax },
      (_, i) =>
        `${String(i).padStart(6, "0")}${userId}`.slice(0, userId.length),
    );
    // Cùng độ dài, khác nội dung ⇒ đúng số byte mà §2.1 tính
    const bytes = segmentPayloadBytesOf({ all: [], userIds });

    expect(bytes).toBe(
      CONDITION_LIMITS.userIdsMax * (CONDITION_LIMITS.userIdMaxLength + 2) +
        (CONDITION_LIMITS.userIdsMax - 1) +
        23,
    );
    expect(bytes).toBe(2_590_022);
    expect(bytes).toBeLessThanOrEqual(SEGMENT.maxProjectBytes);

    /**
     * [v4.10] Và vừa theo cả thước ĐƯỢC CƯỠNG CHẾ
     * (`octet_length(conditions::text)` của jsonb), thứ hằng số nói tới: dài hơn
     * canonical đúng bằng số dấu `,` (10 000: một giữa hai userId, một giữa hai
     * khoá) và `:` (2), vì Postgres in kèm một khoảng trắng sau mỗi dấu.
     */
    const enforced = bytes + CONDITION_LIMITS.userIdsMax + 2;
    expect(enforced).toBe(2_600_024);
    expect(enforced).toBeLessThanOrEqual(SEGMENT.maxProjectBytes);
  });
});
