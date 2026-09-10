import { describe, expect, it } from "vitest";
import { parseFencingToken } from "../src/modules/rule/fencing.js";

/**
 * Bộ bóc fencing token — hàm thuần, kiểm được mà không cần database.
 *
 * Mỗi ca "phải từ chối" dưới đây là một hình dạng mà một bộ bóc dễ dãi sẽ cho
 * qua. Cho qua ở đây nghĩa là một worker tỉnh muộn ghi được — I23 vỡ ở đúng lớp
 * mà nó được thiết kế để giữ.
 */

const SESSION = "0190a1b2-c3d4-4e5f-8a6b-7c8d9e0f1a2b";

describe("parseFencingToken — nhận đúng một hình dạng", () => {
  it('nhận "<sessionId>:<version>" có ngoặc kép', () => {
    expect(parseFencingToken(`"${SESSION}:5"`)).toEqual({
      sessionId: SESSION,
      version: 5,
    });
  });

  it("chuẩn hoá sessionId về chữ thường", () => {
    expect(parseFencingToken(`"${SESSION.toUpperCase()}:7"`).sessionId).toBe(
      SESSION,
    );
  });

  it("version 0 là hợp lệ — RolloutSession.version bắt đầu từ 0", () => {
    expect(parseFencingToken(`"${SESSION}:0"`).version).toBe(0);
  });
});

describe("parseFencingToken — từ chối mọi hình dạng khác", () => {
  it.each([
    ["thiếu header", undefined],
    ["chuỗi rỗng", ""],
    ["thiếu ngoặc kép", `${SESSION}:5`],
    ["entity tag yếu W/", `W/"${SESSION}:5"`],
    ["dấu sao — 'khớp bất kỳ'", "*"],
    ["hai header bị gộp thành danh sách", `"${SESSION}:5", "${SESSION}:6"`],
    ["version không phải số", `"${SESSION}:abc"`],
    ["version âm", `"${SESSION}:-1"`],
    ["version thập phân", `"${SESSION}:5.5"`],
    ["version có số 0 đứng đầu", `"${SESSION}:05"`],
    ["sessionId không phải UUID", '"worker-a:5"'],
    ["ngoặc kép lệch", `"${SESSION}:5`],
  ])("%s ⇒ 400", (_label, header) => {
    expect(() => parseFencingToken(header)).toThrow();
  });

  it("version vượt INTEGER ⇒ 400, không để Postgres ném 22003 thành 500", () => {
    expect(() => parseFencingToken(`"${SESSION}:9999999999"`)).toThrow(
      /INTEGER/,
    );
  });
});
