import { describe, expect, it } from "vitest";
import {
  BUILD_PLATFORM,
  BUILD_TOOLCHAIN,
  NODE_ARCH,
  PINNED_IMAGE,
  TEST_IMAGES,
} from "../src/build-toolchain.js";

/** [Plan #61 QĐ-8] Mọi thứ build dùng đều ghim theo digest hay SHA — tag một mình đẩy đè được */
describe("BUILD_TOOLCHAIN", () => {
  it("mọi image có tag phiên bản VÀ digest sha256 đầy đủ", () => {
    for (const image of [
      ...Object.values(BUILD_TOOLCHAIN.images),
      ...Object.values(TEST_IMAGES),
    ]) {
      expect(image, image).toMatch(PINNED_IMAGE);
      expect(image, `${image}: thiếu tag phiên bản`).toMatch(/:[^@/]+@sha256:/);
    }
  });

  it("action ghim theo SHA 40 ký tự; pack có sha256 của tệp tải", () => {
    expect(BUILD_TOOLCHAIN.actions.checkout.sha).toMatch(/^[0-9a-f]{40}$/);
    expect(BUILD_TOOLCHAIN.pack.linuxSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(BUILD_TOOLCHAIN.pack.version).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("PINNED_IMAGE từ chối tag trần, latest và digest cụt", () => {
    for (const bad of [
      "node:22-alpine",
      "alpine:latest",
      "alpine@sha256:abc",
      "alpine:3.24@sha256:" + "0".repeat(63),
    ]) {
      expect(bad).not.toMatch(PINNED_IMAGE);
    }
  });

  it("kiến trúc build là x86 của node UDP dựng", () => {
    expect(NODE_ARCH).toBe("amd64");
    expect(BUILD_PLATFORM).toBe("linux/amd64");
  });
});
