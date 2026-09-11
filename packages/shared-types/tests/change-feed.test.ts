import { describe, expect, it } from "vitest";
import {
  CONFIG_CHANGE_CHANNEL,
  formatConfigChangeNotice,
  parseConfigChangeNotice,
} from "../src/change-feed.js";

/**
 * Payload của tầng 3 — một định dạng, hai đầu: writer ở `@udp/db`, listener ở
 * Service 2. Lệch nhau thì tầng 3 im lặng rơi về polling, nên hai hàm này đi cặp
 * và được kiểm cùng nhau.
 */

const ENV = "0190a1b2-c3d4-4e5f-8a6b-7c8d9e0f1a2b";

describe("notice của tầng 3", () => {
  it("định dạng rồi đọc lại ra đúng giá trị", () => {
    const notice = { environmentId: ENV, configVersion: 42 };
    expect(parseConfigChangeNotice(formatConfigChangeNotice(notice))).toEqual(
      notice,
    );
  });

  it("kênh giữ đúng tên §6.3", () => {
    expect(CONFIG_CHANGE_CHANNEL).toBe("flag_changed");
  });

  it("payload lớn nhất vẫn cách xa trần 8000 byte của PostgreSQL", () => {
    // Đã đo: pg_notify với payload 8000 byte ném 22023 "payload string too long"
    const payload = formatConfigChangeNotice({
      environmentId: ENV,
      configVersion: 2_147_483_647,
    });
    expect(new TextEncoder().encode(payload).length).toBeLessThan(200);
  });

  it.each([
    ["không phải JSON", "flag_changed"],
    ["mảng", "[]"],
    ["null", "null"],
    ["thiếu version", JSON.stringify({ environmentId: ENV })],
    [
      "environmentId không phải UUID",
      JSON.stringify({ environmentId: "dev", configVersion: 1 }),
    ],
    ["version âm", JSON.stringify({ environmentId: ENV, configVersion: -1 })],
    [
      "version thập phân",
      JSON.stringify({ environmentId: ENV, configVersion: 1.5 }),
    ],
    [
      "version là chuỗi",
      JSON.stringify({ environmentId: ENV, configVersion: "1" }),
    ],
  ])("%s ⇒ null, không ném", (_label, payload) => {
    expect(parseConfigChangeNotice(payload)).toBeNull();
  });
});
