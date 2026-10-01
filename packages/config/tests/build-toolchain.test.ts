import { describe, expect, it } from "vitest";
import {
  BUILD_PLATFORM,
  BUILD_TOOLCHAIN,
  isPinnedStepVersion,
  NODE_ARCH,
  PINNED_IMAGE,
  STEP_IMAGES,
  stepImage,
  TEST_IMAGES,
  type StepImageTool,
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

/** [Plan #61 QĐ-8] Image bước của domain khác: phiên bản trong cấu hình domain ⇒ image ghim digest */
describe("STEP_IMAGES", () => {
  const tools = Object.keys(STEP_IMAGES) as StepImageTool[];

  it("mọi phiên bản trong bảng ra image ghim; mặc định nằm trong bảng", () => {
    for (const tool of tools) {
      const spec = STEP_IMAGES[tool];
      expect(Object.keys(spec.pins), tool).toContain(spec.latest);
      for (const version of Object.keys(spec.pins)) {
        expect(version, tool).toMatch(spec.version);
        expect(stepImage(tool, version), tool).toMatch(PINNED_IMAGE);
      }
    }
  });

  it("ba image Pulumi cùng một tập phiên bản và cùng mặc định", () => {
    const sets = (["pulumi-nodejs", "pulumi-python", "pulumi-go"] as const).map(
      (t) => [
        STEP_IMAGES[t].latest,
        ...Object.keys(STEP_IMAGES[t].pins).sort(),
      ],
    );
    expect(sets[1]).toEqual(sets[0]);
    expect(sets[2]).toEqual(sets[0]);
  });

  it("tag mang hậu tố của tool; digest ghi kèm thắng bảng", () => {
    expect(stepImage("grype", "v0.119.0")).toBe(
      `anchore/grype:v0.119.0-debug@${STEP_IMAGES.grype.pins["v0.119.0"]}`,
    );
    const own = `sha256:${"a".repeat(64)}`;
    expect(stepImage("terraform", `1.12.2@${own}`)).toBe(
      `hashicorp/terraform:1.12.2@${own}`,
    );
  });

  it("phiên bản ngoài bảng không kèm digest, sai dạng hay digest cụt ⇒ không ghim được", () => {
    for (const [tool, version] of [
      ["terraform", "1.12.2"],
      ["grype", "0.119.0"],
      ["checkov", "latest"],
      ["zap", `2.16.0@sha256:${"a".repeat(63)}`],
      ["ansible", "2.21.0@sha256:"],
    ] as const) {
      expect(isPinnedStepVersion(tool, version), `${tool} ${version}`).toBe(
        false,
      );
      expect(() => stepImage(tool, version)).toThrow(/chưa ghim digest/);
    }
  });
});
