import { CREATED_RESOURCE_KINDS } from "@udp/adapter-core";
import { describe, expect, it } from "vitest";
import { gcpLabelCodec, labelKeyHash } from "../../src/gcp/labels.js";

/** Codec label GCP (Plan #26 AC-2): đi–về đúng cho MỌI kind, và mọi label hợp lệ */

const PROJECT = "0f0f0f0f-1111-4222-8333-444455556666";

const tagsFor = (kind: string, name: string) => ({
  "udp.project": PROJECT,
  "udp.key": `${PROJECT}:CLUSTER:${kind}:${name}`,
  "udp.owner": "7a7a7a7a-1111-4222-8333-444455556666",
  "udp.managed": "true",
  "udp.ttl": "2026-12-31T23:59:59.123Z",
});

describe("label GCP", () => {
  for (const kind of CREATED_RESOURCE_KINDS) {
    it(`${kind}: mã hoá hợp lệ theo luật GCP và giải mã về đúng tag chuẩn`, () => {
      const tags = tagsFor(kind, `step-${kind}`);
      const raw = gcpLabelCodec.encode(tags);
      expect(gcpLabelCodec.problems(raw)).toEqual([]);
      expect(gcpLabelCodec.decode(raw)).toEqual(tags);
    });
  }

  it("label udp-name bị sửa tay ⇒ hash không khớp ⇒ KHÔNG dựng lại udp.key", () => {
    const raw = gcpLabelCodec.encode(tagsFor("cluster", "cluster"));
    raw["udp-name"] = "khac";
    expect(gcpLabelCodec.decode(raw)["udp.key"]).toBeUndefined();
  });

  it("udp-key là hash 40 hex, không phải khoá gốc", () => {
    const tags = tagsFor("vpc", "vpc");
    expect(gcpLabelCodec.encode(tags)["udp-key"]).toBe(
      labelKeyHash(tags["udp.key"]),
    );
  });

  it("giá trị không hợp lệ và khoá ngoài udp.* sai luật ⇒ problems nêu ra", () => {
    expect(gcpLabelCodec.problems({ "Hoa-Chu": "x" })).toHaveLength(1);
    expect(gcpLabelCodec.problems({ ok: "Co Khoang Trang" })).toHaveLength(1);
    expect(
      gcpLabelCodec.problems(
        gcpLabelCodec.encode({ "udp.key": "khong:phai:khoa" }),
      ),
    ).not.toEqual([]);
  });

  describe("giá trị tuỳ ý: mã thoát và chia khúc", () => {
    const roundTrip = (owner: string) => {
      const tags = { ...tagsFor("cluster", "cluster"), "udp.owner": owner };
      const raw = gcpLabelCodec.encode(tags);
      expect(gcpLabelCodec.problems(raw)).toEqual([]);
      expect(gcpLabelCodec.decode(raw)).toEqual(tags);
      return raw;
    };

    it("email: `@` và `.` thoát thành `_40`, `_2e`", () => {
      expect(roundTrip("chu@vi-du.test")["udp-owner"]).toBe(
        "chu_40vi-du_2etest",
      );
    });

    it("dấu `_` gốc, chữ hoa và tiếng Việt đi–về chính xác", () => {
      roundTrip("Nguyễn_Văn.A@Công-ty.vn");
    });

    it("giá trị dài ⇒ nhiều khúc ≤ 63, không cắt ngang mã thoát", () => {
      const raw = roundTrip(`${"a.".repeat(60)}@x.test`);
      const chunks = Object.keys(raw).filter((k) => k.startsWith("udp-owner"));
      expect(chunks.length).toBeGreaterThan(2);
      for (const k of chunks) expect(raw[k]).not.toMatch(/_.?$/);
    });

    it("khoá ngoài udp.* có dạng `x_2` mà không có `x` thì giữ nguyên", () => {
      expect(gcpLabelCodec.decode({ team_2: "ops" })).toEqual({
        team_2: "ops",
      });
    });
  });
});
