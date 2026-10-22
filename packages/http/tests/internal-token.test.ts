import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  assertInternalTokens,
  internalAuthHeaders,
  internalTokenFrom,
} from "../src/internal-token.js";

/** [Plan #67] Phía bên gọi: token chiếu đọc từ volume `projected`, một tệp mỗi đích */

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "udp-internal-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("token chiếu của bên gọi (Plan #67)", () => {
  it("đọc lại mỗi lời gọi - kubelet xoay tệp", async () => {
    await writeFile(join(dir, "flag-service"), "tok-1\n");
    const token = internalTokenFrom(dir, "flag-service");
    expect(await token()).toBe("tok-1");
    await writeFile(join(dir, "flag-service"), "tok-2\n");
    expect(await token()).toBe("tok-2");
  });

  it("tệp rỗng là lỗi, không gửi `Bearer ` trống", async () => {
    await writeFile(join(dir, "flag-service"), "\n");
    await expect(internalTokenFrom(dir, "flag-service")()).rejects.toThrow(
      /rỗng/,
    );
  });

  it("đọc thử lúc khởi động nêu đúng đích thiếu", async () => {
    await writeFile(join(dir, "flag-service"), "tok\n");
    await expect(
      assertInternalTokens(dir, ["flag-service"]),
    ).resolves.toBeUndefined();
    await expect(
      assertInternalTokens(dir, ["flag-service", "core-backend"]),
    ).rejects.toThrow(/core-backend/);
  });

  it("header: bí mật luôn có, token khi có", async () => {
    expect(await internalAuthHeaders("s3cret")).toEqual({
      "X-Internal-Secret": "s3cret",
    });
    expect(
      await internalAuthHeaders("s3cret", () => Promise.resolve("tok")),
    ).toEqual({ "X-Internal-Secret": "s3cret", authorization: "Bearer tok" });
  });
});
