import { describe, expect, it } from "vitest";
import {
  DOMAIN_COUNT,
  TOOL_COUNT,
} from "../src/features/landing/landing-facts";
import { landingMarkdown, llmsTxt } from "../src/prerender/entry";

/**
 * [Plan #60 QĐ-9] Bản cho agent đọc (`/llms.txt`, `/index.md`) sinh từ CHÍNH chữ của trang giới thiệu, nên nói cùng một
 * điều với trang — và cùng số đếm được trong mã.
 */
describe("bản cho agent đọc", () => {
  it("llms.txt theo khuôn llmstxt.org: tên, một câu tóm tắt, các đường dẫn đáng đọc", () => {
    const txt = llmsTxt();
    expect(txt.startsWith("# UDP\n\n> ")).toBe(true);
    expect(txt).toContain("(/index.md)");
    expect(txt).toContain("(/terms)");
    expect(txt).toContain("(/privacy)");
    expect(txt).not.toContain("—");
  });

  it("index.md có cả hai ngôn ngữ, số domain và công cụ đếm được, và đủ công cụ", () => {
    const md = landingMarkdown();
    expect(md).toContain("# Phát hành an toàn, trên hạ tầng của chính bạn.");
    expect(md).toContain("# Ship safely, on infrastructure you own.");
    expect(md).toContain(
      `## ${String(DOMAIN_COUNT)} domain, ${String(TOOL_COUNT)} công cụ.`,
    );
    expect(md).toContain("argo-rollouts");
    expect(md).toContain("prometheus-grafana");
  });
});
