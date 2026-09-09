import { beforeAll, describe, expect, it } from "vitest";
import { readDesignDoc } from "../src/design-doc.js";

/**
 * A4 + A5 — tài liệu không được nhắc tới thứ không tồn tại, và không được tự
 * khai sai con số của chính nó.
 *
 * Trước đây tôi kiểm hai việc này bằng grep thủ công sau mỗi đợt sửa lớn, và nó
 * hỏng đúng như mọi việc làm bằng tay: sau khi thêm I39, dòng "Tổng cuối: 40 bất
 * biến" nằm im ở đó cho tới khi một agent QA tình cờ đọc tới. Chốt đếm mã lỗi
 * trong `problem.ts` thì lại bắt được ngay lúc thêm mã thứ 20 — khác biệt duy
 * nhất là cái đó chạy tự động.
 */

/**
 * Khối lịch sử phiên bản bắt đầu ở đây và chạy tới hết file.
 *
 * Loại nó khỏi phép kiểm tham chiếu là CÓ CHỦ ĐÍCH, không phải né lỗi: changelog
 * nói về những thứ từng tồn tại ở v2/v3 và nay đã đổi — câu "bất biến I15 tách
 * thành I15a/I15b/I15c" phải nhắc `I15` mới có nghĩa. Bắt nó là bắt tài liệu
 * quên mất lịch sử của chính nó.
 *
 * Nhưng vẫn TÍNH nó cho phép kiểm con số, vì câu "Tổng cuối" nằm trong đó.
 */
const CHANGELOG_MARKER = "_UDP Technical Design Document v4.0_";

let definedSections: Set<string>;
let definedInvariants: Set<string>;
let definedMeasurements: Set<string>;
let definedAdrs: Set<string>;
let definedCrashPoints: Set<string>;
/** Toàn văn, đã bỏ code block */
let prose: string;
/** Như trên nhưng cắt phần lịch sử phiên bản */
let current: string;

/** Bỏ khối code để không nhặt nhầm tham chiếu trong ví dụ code */
function stripCodeBlocks(input: string[]): string[] {
  const out: string[] = [];
  let inFence = false;
  for (const l of input) {
    if (l.trimStart().startsWith("```")) {
      inFence = !inFence;
      continue;
    }
    out.push(inFence ? "" : l);
  }
  return out;
}

function distinct(matches: Iterable<RegExpMatchArray>): Set<string> {
  const s = new Set<string>();
  for (const m of matches) if (m[1] !== undefined) s.add(m[1]);
  return s;
}

beforeAll(() => {
  const lines = readDesignDoc();
  const doc = lines.join("\n");
  prose = stripCodeBlocks(lines).join("\n");

  const cut = prose.indexOf(CHANGELOG_MARKER);
  if (cut < 0) throw new Error(`Không tìm thấy mốc lịch sử phiên bản: ${CHANGELOG_MARKER}`);
  current = prose.slice(0, cut);

  definedSections = distinct(doc.matchAll(/^#{2,4}\s+(\d+(?:\.\d+)*)\.?\s/gm));
  definedInvariants = distinct(doc.matchAll(/^\|\s*\*{0,2}(I\d+[a-c]?)\*{0,2}\s*\|/gm));
  definedMeasurements = distinct(doc.matchAll(/^\|\s*\*{0,2}(E\d+)\*{0,2}\s*\|/gm));
  definedAdrs = distinct(doc.matchAll(/^#{2,4}\s+(ADR-\d+)/gm));
  definedCrashPoints = distinct(doc.matchAll(/^\|\s*\*{0,2}(K\d+)\*{0,2}\s*\|/gm));
});

describe("A4 — mọi tham chiếu chéo đều trỏ tới thứ có thật", () => {
  const cases: ReadonlyArray<readonly [string, RegExp, () => Set<string>]> = [
    ["§X.Y", /§(\d+(?:\.\d+)*)/g, () => definedSections],
    ["bất biến I-n", /\b(I\d+[a-c]?)\b/g, () => definedInvariants],
    ["phép đo E-n", /\b(E\d+)\b/g, () => definedMeasurements],
    ["ADR-n", /\b(ADR-\d+)\b/g, () => definedAdrs],
    ["điểm crash K-n", /\b(K\d+)\b/g, () => definedCrashPoints],
  ];

  for (const [label, pattern, defined] of cases) {
    it(`${label} được nhắc đều tồn tại`, () => {
      const referenced = distinct(current.matchAll(pattern));
      const dangling = [...referenced].filter((r) => !defined().has(r)).sort();
      expect(dangling).toEqual([]);
    });
  }
});

describe("A5 — con số tài liệu tự tuyên bố phải khớp thực tế", () => {
  /**
   * Đọc con số từ MỘT câu tuyên bố chính tắc, không phải từ mọi chỗ nhắc tới
   * cụm từ đó. Tài liệu có đầy "9 domain heavy", "7 domain light", "13 phép đo"
   * trong ngữ cảnh khác — bắt mù sẽ ra một test hay đỏ giả, và test hay đỏ giả
   * thì người ta tắt đi.
   */
  function claimed(anchor: RegExp): number {
    const found = [...prose.matchAll(anchor)].map((m) => Number(m[1]));
    if (found.length === 0) throw new Error(`Không tìm thấy câu tuyên bố khớp ${anchor}`);
    const unique = [...new Set(found)];
    if (unique.length > 1) {
      throw new Error(`Tài liệu tự nói hai con số khác nhau cho ${anchor}: ${unique.join(", ")}`);
    }
    return unique[0] as number;
  }

  it("số bất biến", () => {
    expect(definedInvariants.size).toBe(claimed(/Tổng cuối: \*\*(\d+) bất biến\*\*/g));
  });

  it("số phép đo", () => {
    expect(definedMeasurements.size).toBe(claimed(/Tổng cuối:[^\n]*?(\d+) phép đo/g));
  });

  it("số ADR", () => {
    expect(definedAdrs.size).toBe(claimed(/Tổng cuối:[^\n]*?(\d+) ADR/g));
  });

  it("số điểm crash", () => {
    expect(definedCrashPoints.size).toBe(claimed(/Lưới K1–K(\d+)/g));
  });

  it("số mã lỗi khớp ERROR_CATALOG", async () => {
    // Nguồn sự thật là code: `problem.ts` đã có chốt đếm lúc nạp module, nên
    // import nó vào đây là để nối hai chốt lại với nhau thành một vòng khép kín.
    const { ERROR_CATALOG } = await import("@udp/shared-types/problem");
    expect(Object.keys(ERROR_CATALOG).length).toBe(claimed(/\*\*Danh mục (\d+) mã\*\*/g));
  });

  it("số domain khớp DOMAIN_CATALOG_SEED", async () => {
    const { DOMAIN_CATALOG_SEED } = await import("@udp/config");
    expect(DOMAIN_CATALOG_SEED.length).toBe(claimed(/\*\*(\d+) domain\*\*, khớp/g));
  });
});
