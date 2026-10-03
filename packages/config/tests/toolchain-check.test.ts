import { describe, expect, it } from "vitest";
import {
  BUILD_TOOLCHAIN,
  PINNED_IMAGE,
  STEP_IMAGES,
} from "../src/build-toolchain.js";
import {
  checkoutFinding,
  dockerfileImages,
  imageFinding,
  isActionable,
  newerTags,
  parseImageRef,
  pinnedReleases,
  publishedSha256Of,
  releaseFinding,
  parseVersionTag,
  pinnedImages,
  renderReport,
} from "../src/toolchain-check.js";

/** [Plan #61 QĐ-13] Phần thuần của `toolchain:check` — phần mạng chạy ở workflow tuần */
const D1 = `sha256:${"1".repeat(64)}`;
const D2 = `sha256:${"2".repeat(64)}`;

describe("toolchain:check — gom và tách", () => {
  it("gom đủ image ghim (công cụ, test, bản mặc định của bước domain, Dockerfile) — image nào cũng ghim", () => {
    const pins = pinnedImages([
      { source: "Dockerfile", image: `node:22.1.0-alpine@${D1}` },
    ]);
    const sources = pins.map((p) => p.source);
    expect(sources).toContain("BUILD_TOOLCHAIN.images.buildkit");
    expect(sources).toContain("TEST_IMAGES.nodejs");
    expect(sources).toContain("STEP_IMAGES.terraform");
    expect(sources).toContain("Dockerfile");
    for (const p of pins) expect(p.image, p.source).toMatch(PINNED_IMAGE);
    // Bản cũ của bước domain ở lại để không nâng âm thầm — không theo dõi
    expect(
      pins.filter((p) => p.source === "STEP_IMAGES.terraform"),
    ).toHaveLength(1);
    expect(pins.find((p) => p.source === "STEP_IMAGES.grype")?.image).toContain(
      `:${STEP_IMAGES.grype.latest}-debug@`,
    );
  });

  it("tách image: Docker Hub chính thức, Docker Hub có namespace, registry riêng", () => {
    expect(parseImageRef(`alpine:3.24.2@${D1}`)).toEqual({
      host: "registry-1.docker.io",
      repository: "library/alpine",
      tag: "3.24.2",
      digest: D1,
    });
    expect(parseImageRef(`moby/buildkit:v0.33.1-rootless@${D1}`)).toMatchObject(
      {
        host: "registry-1.docker.io",
        repository: "moby/buildkit",
        tag: "v0.33.1-rootless",
      },
    );
    expect(
      parseImageRef(`mcr.microsoft.com/dotnet/sdk:10.0.401@${D1}`),
    ).toMatchObject({
      host: "mcr.microsoft.com",
      repository: "dotnet/sdk",
      tag: "10.0.401",
    });
    expect(() => parseImageRef("alpine:3.24.2")).toThrow(/không ghim digest/);
  });

  it("tag ⇒ tiền tố, số, hậu tố; tag không theo phiên bản ⇒ null", () => {
    expect(parseVersionTag("v0.33.1-rootless")).toEqual({
      prefix: "v",
      numbers: [0, 33, 1],
      suffix: "-rootless",
    });
    expect(parseVersionTag("3.9.16-eclipse-temurin-25")).toEqual({
      prefix: "",
      numbers: [3, 9, 16],
      suffix: "-eclipse-temurin-25",
    });
    expect(parseVersionTag("latest")).toBeNull();
  });

  it("FROM ghim của Dockerfile; bỏ tham chiếu tầng trước và FROM không ghim", () => {
    const text = [
      `FROM node:22.1.0-alpine@${D1} AS build`,
      "FROM build AS test",
      "from python:3.12",
      `FROM node:22.1.0-alpine@${D1}`,
    ].join("\n");
    expect(dockerfileImages(text)).toEqual([
      `node:22.1.0-alpine@${D1}`,
      `node:22.1.0-alpine@${D1}`,
    ]);
  });
});

describe("toolchain:check — phân loại", () => {
  const tags = [
    "22.1.0-alpine",
    "22.1.4-alpine",
    "22.3.0-alpine",
    "26.0.0-alpine",
    "22.1.5",
    "22.1.9-slim",
    "latest",
    "22.1.6-alpine-rc",
  ];

  it("bản vá = cùng mọi thành phần trừ cái cuối, cùng hậu tố; dòng mới = mới nhất ở dòng khác", () => {
    expect(newerTags("22.1.0-alpine", tags)).toEqual({
      patch: "22.1.4-alpine",
      newerLine: "26.0.0-alpine",
    });
    expect(newerTags("26.0.0-alpine", tags)).toEqual({
      patch: null,
      newerLine: null,
    });
    expect(
      newerTags("v0.33.1-rootless", [
        "v0.33.2-rootless",
        "v0.34.0-rootless",
        "v0.33.9",
      ]),
    ).toEqual({
      patch: "v0.33.2-rootless",
      newerLine: "v0.34.0-rootless",
    });
  });

  it("bản vá ⇒ việc cần làm; chỉ có dòng mới ⇒ chỉ để biết (job tuần không đỏ vĩnh viễn)", () => {
    const pin = {
      source: "TEST_IMAGES.nodejs",
      image: `node:22.1.0-alpine@${D1}`,
    };
    const patch = imageFinding(pin, {
      tagDigest: D1,
      pinnedDigestExists: true,
      tags,
    });
    expect(patch.status).toBe("update");
    expect(patch.detail).toBe(
      "bản vá: 22.1.4-alpine; dòng mới hơn: 26.0.0-alpine",
    );
    expect(isActionable(patch)).toBe(true);

    const onlyLine = imageFinding(
      { source: "x", image: `node:22.1.4-alpine@${D1}` },
      {
        tagDigest: D1,
        pinnedDigestExists: true,
        tags: ["22.1.4-alpine", "26.0.0-alpine"],
      },
    );
    expect(onlyLine.status).toBe("newer-line");
    expect(isActionable(onlyLine)).toBe(false);
  });

  it("tag đẩy lại (digest khác) ⇒ moved; digest ghim mất ⇒ broken", () => {
    const pin = { source: "x", image: `alpine:3.24.2@${D1}` };
    expect(
      imageFinding(pin, {
        tagDigest: D2,
        pinnedDigestExists: true,
        tags: ["3.24.2"],
      }),
    ).toMatchObject({
      status: "moved",
      detail: expect.stringContaining(D2) as string,
    });
    expect(
      imageFinding(pin, { tagDigest: D1, pinnedDigestExists: false, tags: [] })
        .status,
    ).toBe("broken");
    expect(
      imageFinding(pin, {
        tagDigest: D1,
        pinnedDigestExists: true,
        tags: ["3.24.2"],
      }).status,
    ).toBe("ok");
  });

  it("pack, cosign, oras: sha256 công bố phải khớp bản ghim; bản vá là việc cần làm, dòng mới chỉ để biết", () => {
    for (const release of pinnedReleases()) {
      const [major, minor, patch] = release.version.split(".").map(Number) as [
        number,
        number,
        number,
      ];
      const ok = {
        latestTag: `v${release.version}`,
        publishedSha256: release.sha256,
      };
      expect(releaseFinding(release, ok).status, release.key).toBe("ok");
      expect(
        releaseFinding(release, {
          ...ok,
          latestTag: `v${String(major)}.${String(minor)}.${String(patch + 1)}`,
        }).status,
      ).toBe("update");
      expect(
        releaseFinding(release, {
          ...ok,
          latestTag: `v${String(major)}.${String(minor + 1)}.0`,
        }).status,
      ).toBe("newer-line");
      expect(
        releaseFinding(release, { ...ok, publishedSha256: "0".repeat(64) })
          .status,
      ).toBe("broken");
    }
    expect(pinnedReleases().map((r) => r.key)).toEqual([
      "pack",
      "cosign",
      "oras",
    ]);
  });

  it("đọc sha256 công bố: tệp riêng một dòng trần, hay danh sách chung theo tên tệp", () => {
    const sha = "a".repeat(64);
    expect(publishedSha256Of(`${sha}\n`, "pack-v1-linux.tgz")).toBe(sha);
    expect(
      publishedSha256Of(
        `${"b".repeat(64)}  cosign-darwin-amd64\n${sha}  cosign-linux-amd64\n`,
        "cosign-linux-amd64",
      ),
    ).toBe(sha);
    expect(publishedSha256Of(`${sha} *oras.tar.gz`, "oras.tar.gz")).toBe(sha);
    expect(publishedSha256Of("không có gì", "x")).toBeNull();
  });

  it("actions/checkout: tag ghim phải trỏ đúng SHA ghim", () => {
    const { sha, version } = BUILD_TOOLCHAIN.actions.checkout;
    expect(checkoutFinding({ latestTag: version, tagCommit: sha }).status).toBe(
      "ok",
    );
    expect(
      checkoutFinding({ latestTag: version, tagCommit: "f".repeat(40) }),
    ).toMatchObject({
      status: "broken",
      detail: expect.stringContaining(sha) as string,
    });
    expect(
      checkoutFinding({ latestTag: version, tagCommit: null }).status,
    ).toBe("broken");
  });

  it("báo cáo: việc cần làm lên đầu, đếm đúng, ô không vỡ bảng", () => {
    const report = renderReport([
      { kind: "image", source: "a", subject: "x:1", status: "ok", detail: "" },
      {
        kind: "image",
        source: "b",
        subject: "y:1",
        status: "newer-line",
        detail: "dòng mới hơn: 2",
      },
      {
        kind: "image",
        source: "c",
        subject: "z:1",
        status: "broken",
        detail: "a|b",
      },
    ]);
    expect(report).toContain("1/3 mục cần làm");
    const rows = report
      .split("\n")
      .filter(
        (l) =>
          l.startsWith("| ") &&
          !l.startsWith("| Trạng") &&
          !l.startsWith("| ---"),
      );
    expect(rows[0]).toContain("HỎNG");
    expect(rows[0]).toContain("a/b");
    expect(rows.at(-1)).toContain("ổn");
  });
});
