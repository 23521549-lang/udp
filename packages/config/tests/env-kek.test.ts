import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * [v4.10] AC-17 — guard KEK của `env.ts` (§4.3, §2.10).
 *
 * `env.ts` **ném lúc import**, nên mọi phép ở đây đặt `process.env` rồi
 * `vi.resetModules()` và nhập lại. Đó không phải cách vòng vo: fail-fast lúc khởi động là
 * chính tính chất cần kiểm, và một hàm `validate(env)` xuất ra riêng để dễ test sẽ kiểm
 * một đường đi KHÁC với đường mà tiến trình thật đi qua.
 *
 * `dotenv` không ghi đè biến đã có trong `process.env`, nên đặt một biến trước khi nhập
 * sẽ thắng giá trị trong `.env` — và mọi biến khác vẫn lấy từ `.env` thật, tức nền cấu
 * hình hợp lệ. Nhờ vậy mỗi phép chỉ đổi đúng thứ nó đang kiểm.
 */

const KEK_KEYS = ["UDP_KEK_VERSION", "UDP_KEK_V1", "UDP_KEK_V2"] as const;

let saved: Partial<Record<(typeof KEK_KEYS)[number], string | undefined>> = {};

function key32(): string {
  return randomBytes(32).toString("base64");
}

async function loadEnv(): Promise<
  { ok: true } | { ok: false; message: string }
> {
  vi.resetModules();
  try {
    await import("../src/env.js");
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

beforeEach(() => {
  saved = {};
  for (const k of KEK_KEYS) saved[k] = process.env[k];
});

afterEach(() => {
  for (const k of KEK_KEYS) {
    const v = saved[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  vi.resetModules();
});

describe("mọi v trong [1, UDP_KEK_VERSION] phải có UDP_KEK_V<v>", () => {
  it("version 1 với V1 có mặt ⇒ khởi động được", async () => {
    process.env.UDP_KEK_VERSION = "1";
    process.env.UDP_KEK_V1 = key32();
    delete process.env.UDP_KEK_V2;
    expect(await loadEnv()).toEqual({ ok: true });
  });

  it("version 2 có cả V1 và V2 (khác nhau) ⇒ khởi động được", async () => {
    process.env.UDP_KEK_VERSION = "2";
    process.env.UDP_KEK_V1 = key32();
    process.env.UDP_KEK_V2 = key32();
    expect(await loadEnv()).toEqual({ ok: true });
  });

  it("version 2 mà thiếu V2 ⇒ KHÔNG khởi động", async () => {
    process.env.UDP_KEK_VERSION = "2";
    process.env.UDP_KEK_V1 = key32();
    delete process.env.UDP_KEK_V2;
    const res = await loadEnv();
    expect(res.ok).toBe(false);
    expect(res.ok === false && res.message).toContain("UDP_KEK_V2");
  });

  /**
   * `UDP_KEK_V1` không dùng được thì KHÔNG khởi động, kể cả khi V2 đã có.
   *
   * Nói chính xác ai bảo vệ ca này, vì phép đầu tiên viết ra đã đỏ và dạy đúng điều đó:
   * **không phải vòng lặp refine** mà là schema — `UDP_KEK_V1` là `base64Key(32)` không
   * `.optional()`. Nên "thiếu hẳn V1" là ca không dựng được ở đây: `dotenv` nạp `.env`
   * thật lúc import, và `delete process.env.UDP_KEK_V1` chỉ mở đường cho `.env` điền nó
   * trở lại. Đặt chuỗi RỖNG thì `dotenv` không ghi đè (khoá đã tồn tại), và đó là cách
   * dựng được ca "V1 không dùng được".
   *
   * Điều guard mới thêm so với bản cũ là ca `v = 2` ở phép trên, không phải ca này.
   */
  it("V1 không dùng được ⇒ KHÔNG khởi động, kể cả khi V2 đã có", async () => {
    process.env.UDP_KEK_VERSION = "2";
    process.env.UDP_KEK_V1 = "";
    process.env.UDP_KEK_V2 = key32();
    const res = await loadEnv();
    expect(res.ok).toBe(false);
    expect(res.ok === false && res.message).toContain("UDP_KEK_V1");
  });

  it("version 3 vượt trần ⇒ KHÔNG khởi động, và thông điệp nói về trần", async () => {
    process.env.UDP_KEK_VERSION = "3";
    process.env.UDP_KEK_V1 = key32();
    process.env.UDP_KEK_V2 = key32();
    const res = await loadEnv();
    expect(res.ok).toBe(false);
    expect(res.ok === false && res.message).toContain("UDP_KEK_VERSION");
  });
});

describe("V2 không được trùng V1", () => {
  /**
   * Cách nhanh nhất để "thử xoay khoá" là copy `UDP_KEK_V1` sang `UDP_KEK_V2` rồi tăng
   * version. Mọi thứ chạy, `kek_version` lên 2, job `rotate-kek` báo thành công — và
   * khoá được cho là đã thay thì vẫn mở được toàn bộ dữ liệu cũ lẫn mới. Tức là xoay
   * khoá đã "thành công" mà không thay thế gì.
   */
  it("V2 === V1 ⇒ KHÔNG khởi động", async () => {
    const same = key32();
    process.env.UDP_KEK_VERSION = "2";
    process.env.UDP_KEK_V1 = same;
    process.env.UDP_KEK_V2 = same;
    const res = await loadEnv();
    expect(res.ok).toBe(false);
    expect(res.ok === false && res.message).toContain("trùng UDP_KEK_V1");
  });

  /**
   * Nhưng V2 trùng V1 khi version VẪN là 1 cũng phải chặn.
   *
   * Nếu chỉ kiểm khi `UDP_KEK_VERSION === 2` thì một môi trường copy sẵn hai biến giống
   * nhau sẽ xanh cho tới ngày ai đó tăng version — và ngày đó là ngày tệ nhất để phát
   * hiện, vì lúc ấy người ta tin rằng vừa xoay khoá xong.
   */
  it("V2 === V1 vẫn bị chặn khi version còn là 1", async () => {
    const same = key32();
    process.env.UDP_KEK_VERSION = "1";
    process.env.UDP_KEK_V1 = same;
    process.env.UDP_KEK_V2 = same;
    const res = await loadEnv();
    expect(res.ok).toBe(false);
    expect(res.ok === false && res.message).toContain("trùng UDP_KEK_V1");
  });
});

describe("KEK phải là base64 giải ra đúng 32 byte", () => {
  it("khoá 30 byte ⇒ KHÔNG khởi động", async () => {
    process.env.UDP_KEK_VERSION = "1";
    process.env.UDP_KEK_V1 = randomBytes(30).toString("base64");
    delete process.env.UDP_KEK_V2;
    const res = await loadEnv();
    expect(res.ok).toBe(false);
    expect(res.ok === false && res.message).toContain("UDP_KEK_V1");
  });

  it("chuỗi không phải base64 ⇒ KHÔNG khởi động", async () => {
    process.env.UDP_KEK_VERSION = "1";
    process.env.UDP_KEK_V1 = "khong-phai-base64-!!!";
    delete process.env.UDP_KEK_V2;
    const res = await loadEnv();
    expect(res.ok).toBe(false);
    expect(res.ok === false && res.message).toContain("UDP_KEK_V1");
  });
});
