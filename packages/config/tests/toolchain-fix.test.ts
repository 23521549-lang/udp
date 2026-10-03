import {
  applyEdits,
  GOLDEN_PATH_FROMS,
  imageEdits,
  isFixable,
  releaseEdits,
  TOOLCHAIN_FILE,
  type Finding,
} from "../src/toolchain-check.js";
import { describe, expect, it } from "vitest";

/**
 * [Plan #61 61d-3c-2] Phần THUẦN của `--fix`, và năm chỗ nó phải TỪ CHỐI.
 *
 * Mỗi lời từ chối ở đây là một chế độ hỏng đã kiểm ở nguồn, không phải phòng xa. Vòng QA của 61d-3c tìm ra cả năm,
 * và ba trong số đó sẽ làm hỏng pipeline của **mọi** project khách nếu `--fix` nhận chúng.
 */

const finding = (over: Partial<Finding> = {}): Finding => ({
  kind: "image",
  source: "TEST_IMAGES.nodejs",
  subject: "node:22.23.3-alpine",
  status: "update",
  detail: "bản vá: 22.23.4",
  ...over,
});

describe("isFixable — allowlist dương, và năm lời từ chối", () => {
  it("nhận ghim image và hai bản phát hành của bảng", () => {
    expect(isFixable(finding())).toBe(true);
    expect(
      isFixable(finding({ source: "BUILD_TOOLCHAIN.images.alpine" })),
    ).toBe(true);
    expect(
      isFixable(finding({ source: "BUILD_TOOLCHAIN.pack", kind: "release" })),
    ).toBe(true);
    expect(
      isFixable(finding({ source: "BUILD_TOOLCHAIN.oras", kind: "release" })),
    ).toBe(true);
  });

  it("TỪ CHỐI `moved` — đó có thể là một lần đẩy đè tag", () => {
    /**
     * `moved` nghĩa là *tag giữ nguyên, digest đổi*. Đây đúng là sự cố Trivy 03/2026 (CVE-2026-33634, đẩy đè 75/76
     * tag của `trivy-action` để lấy secret CI) mà `build-toolchain.ts` ghim theo digest để chống. Một `--fix` theo
     * `isActionable` sẽ TỰ ĐỘNG HOÁ việc nhận digest của kẻ tấn công, kèm một PR trông như PR làm mới checksum.
     */
    expect(isFixable(finding({ status: "moved" }))).toBe(false);
    expect(isFixable(finding({ status: "broken" }))).toBe(false);
    expect(isFixable(finding({ status: "newer-line" }))).toBe(false);
  });

  it("TỪ CHỐI STEP_IMAGES — không phải một phép thay chuỗi", () => {
    /** `stepImage()` lắp chuỗi lúc chạy; sửa là CHÈN vào `pins` cộng đổi `latest`, tức đổi mặc định cấu hình domain */
    expect(isFixable(finding({ source: "STEP_IMAGES.terraform" }))).toBe(false);
  });

  it("TỪ CHỐI actions.checkout — ghim theo SHA commit, một loại khác", () => {
    expect(
      isFixable(
        finding({ source: "BUILD_TOOLCHAIN.actions.checkout", kind: "action" }),
      ),
    ).toBe(false);
  });

  it("TỪ CHỐI cosign — có một điều kiện con người phải kiểm", () => {
    /** Bản mới phải kéo `sigstore/sigstore` ≥ v1.10.10 (Azure KMS sigstore#2409); nâng tự động có thể KÝ SAI */
    expect(
      isFixable(finding({ source: "BUILD_TOOLCHAIN.cosign", kind: "release" })),
    ).toBe(false);
  });

  it("TỪ CHỐI builder và buildkit — mỗi cái có ba hằng vệ tinh không ai canh", () => {
    expect(
      isFixable(finding({ source: "BUILD_TOOLCHAIN.images.builder" })),
    ).toBe(false);
    expect(
      isFixable(finding({ source: "BUILD_TOOLCHAIN.images.buildkit" })),
    ).toBe(false);
  });

  it("TỪ CHỐI ghim chart — một bản vá chart là bump adapter + upgradesFrom (§8.6)", () => {
    expect(
      isFixable(finding({ kind: "chart", source: "HELM_CHART_PINS.kyverno" })),
    ).toBe(false);
  });
});

describe("imageEdits — hai đầu của bất biến Dockerfile sửa CÙNG LÚC", () => {
  const OLD = "node:22.23.3-alpine@sha256:" + "a".repeat(64);
  const NEW = "node:22.23.4-alpine@sha256:" + "b".repeat(64);

  it("ghim thường ⇒ một phép thay trong bảng", () => {
    expect(
      imageEdits({
        source: "BUILD_TOOLCHAIN.images.alpine",
        oldImage: OLD,
        newImage: NEW,
      }),
    ).toEqual([
      {
        file: TOOLCHAIN_FILE,
        from: OLD,
        to: NEW,
        expect: 1,
        source: "BUILD_TOOLCHAIN.images.alpine",
      },
    ]);
  });

  it("TEST_IMAGES.nodejs ⇒ thêm phép thay cho Dockerfile, với SỐ LẦN thật", () => {
    /**
     * `golden-path-pins.test.ts` khẳng định **mọi** dòng `FROM` bằng đúng `TEST_IMAGES.<runtime>`, và mỗi
     * Dockerfile có hai dòng `FROM`. Sửa một đầu thì cổng kia đỏ; luật "đúng một lần" thì ném.
     */
    const edits = imageEdits({
      source: "TEST_IMAGES.nodejs",
      oldImage: OLD,
      newImage: NEW,
      fromCount: 2,
    });
    expect(edits).toHaveLength(2);
    expect(edits[1]).toMatchObject({
      file: GOLDEN_PATH_FROMS["TEST_IMAGES.nodejs"],
      expect: 2,
    });
  });

  it("fromCount = 0 ⇒ KHÔNG sinh phép thay cho Dockerfile (tệp không đọc được)", () => {
    expect(
      imageEdits({
        source: "TEST_IMAGES.nodejs",
        oldImage: OLD,
        newImage: NEW,
        fromCount: 0,
      }),
    ).toHaveLength(1);
  });
});

describe("releaseEdits — version và sha256 là HAI phép thay", () => {
  it("sinh đúng hai phép thay, mỗi cái một lần", () => {
    expect(
      releaseEdits({
        source: "BUILD_TOOLCHAIN.pack",
        oldVersion: "0.40.9",
        newVersion: "0.40.10",
        oldSha256: "c".repeat(64),
        newSha256: "d".repeat(64),
      }),
    ).toEqual([
      {
        file: TOOLCHAIN_FILE,
        from: 'version: "0.40.9"',
        to: 'version: "0.40.10"',
        expect: 1,
        source: "BUILD_TOOLCHAIN.pack",
      },
      {
        file: TOOLCHAIN_FILE,
        from: "c".repeat(64),
        to: "d".repeat(64),
        expect: 1,
        source: "BUILD_TOOLCHAIN.pack (sha256)",
      },
    ]);
  });
});

describe("applyEdits — ném thì KHÔNG tệp nào bị sửa", () => {
  const files = {
    [TOOLCHAIN_FILE]:
      'const a = "x:1@sha256:aa";\nconst b = "y:2@sha256:bb";\n',
    Dockerfile: "FROM x:1@sha256:aa\nFROM x:1@sha256:aa\n",
  };

  it("khớp đúng số khai ⇒ thay hết", () => {
    const out = applyEdits(files, [
      {
        file: TOOLCHAIN_FILE,
        from: "x:1@sha256:aa",
        to: "x:2@sha256:cc",
        expect: 1,
        source: "t",
      },
      {
        file: "Dockerfile",
        from: "x:1@sha256:aa",
        to: "x:2@sha256:cc",
        expect: 2,
        source: "t",
      },
    ]);
    expect(out[TOOLCHAIN_FILE]).toContain("x:2@sha256:cc");
    expect(out["Dockerfile"]).toBe("FROM x:2@sha256:cc\nFROM x:2@sha256:cc\n");
    // Đầu vào không bị sửa tại chỗ
    expect(files["Dockerfile"]).toBe(
      "FROM x:1@sha256:aa\nFROM x:1@sha256:aa\n",
    );
  });

  it("khớp 0 lần ⇒ NÉM (giả định về hình dạng tệp đã sai)", () => {
    expect(() =>
      applyEdits(files, [
        {
          file: TOOLCHAIN_FILE,
          from: "khong-co",
          to: "x",
          expect: 1,
          source: "t",
        },
      ]),
    ).toThrow("khớp 0 lần");
  });

  it("khớp nhiều hơn số khai ⇒ NÉM (đang chạm một ghim khác)", () => {
    expect(() =>
      applyEdits(files, [
        {
          file: "Dockerfile",
          from: "x:1@sha256:aa",
          to: "z",
          expect: 1,
          source: "t",
        },
      ]),
    ).toThrow("khớp 2 lần, khai 1");
  });

  it("tệp không có nội dung ⇒ NÉM, không im lặng bỏ qua", () => {
    expect(() =>
      applyEdits(files, [
        { file: "khong-doc-duoc", from: "a", to: "b", expect: 1, source: "t" },
      ]),
    ).toThrow("không có nội dung");
  });

  it("một phép thay hỏng ⇒ KHÔNG phép thay nào trước nó được ghi ra ngoài", () => {
    /** `applyEdits` trả về object MỚI, nên bên gọi chỉ ghi tệp sau khi nó trả về — ném là không ghi gì */
    let out: Record<string, string> | null = null;
    try {
      out = applyEdits(files, [
        {
          file: TOOLCHAIN_FILE,
          from: "x:1@sha256:aa",
          to: "x:2@sha256:cc",
          expect: 1,
          source: "t",
        },
        {
          file: TOOLCHAIN_FILE,
          from: "khong-co",
          to: "x",
          expect: 1,
          source: "t",
        },
      ]);
    } catch {
      // mong đợi
    }
    expect(out).toBeNull();
    expect(files[TOOLCHAIN_FILE]).toContain("x:1@sha256:aa");
  });
});
