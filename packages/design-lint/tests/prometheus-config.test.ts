import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { k8sNamespaceFor } from "@udp/config/constants";
import {
  SEED_CHECKOUT_FLAG_KEY,
  SEED_IDS,
  SEED_PROJECT_NAME,
} from "@udp/db/seed-constants";
import { describe, expect, it } from "vitest";

/**
 * [v4.8] Cấu hình scrape và dữ liệu seed không được trôi khỏi nhau (§7.4, §16).
 *
 * Middleware của provider không phát `namespace` — Prometheus gắn khi scrape. Mọi
 * truy vấn của Service 1/3 lọc `namespace = environments.k8s_namespace`, nên một
 * nhãn lệch một ký tự là probe pha 1 báo "không có lưu lượng" và rollout bị chặn
 * mà không có gì sai ở code. Đọc YAML bằng regex hẹp quanh ĐÚNG một job — thêm
 * thư viện YAML cho một phép so thì phí.
 */

const here = dirname(fileURLToPath(import.meta.url));
const config = readFileSync(
  resolve(here, "../../../docker/prometheus.yml"),
  "utf8",
);

/** Khối của một job: từ `- job_name: <tên>` tới job kế tiếp (hoặc hết file) */
function jobBlock(name: string): string {
  const start = config.indexOf(`- job_name: ${name}`);
  if (start === -1) throw new Error(`prometheus.yml thiếu job ${name}`);
  const next = config.indexOf("- job_name:", start + 1);
  return config.slice(start, next === -1 ? undefined : next);
}

describe("docker/prometheus.yml", () => {
  it("job sample-app gắn namespace = k8s_namespace của env dev trong seed", () => {
    const block = jobBlock("sample-app");
    const match = /\n\s+namespace:\s*"?([a-z0-9-]+)"?\s*\n/.exec(`${block}\n`);
    expect(match?.[1]).toBe(
      k8sNamespaceFor(SEED_PROJECT_NAME, SEED_IDS.project, "dev"),
    );
  });

  it("job sample-app scrape cả hai instance (ô lỗi một phần pod của E5)", () => {
    const block = jobBlock("sample-app");
    expect(block).toContain("host.docker.internal:3010");
    expect(block).toContain("host.docker.internal:3011");
  });
});

describe("sample-app mặc định khớp seed", () => {
  // sample-app không được import `@udp/db` (nó là ứng dụng KHÁCH) — đọc văn bản
  const app = resolve(here, "../../../apps/sample-app");

  it("CHECKOUT_FLAG_KEY mặc định (config.ts và .env.example) là flag canary của seed", () => {
    const config = readFileSync(resolve(app, "src/config.ts"), "utf8");
    const example = readFileSync(resolve(app, ".env.example"), "utf8");
    expect(
      /CHECKOUT_FLAG_KEY:[^\n]*\.default\("([^"]+)"\)/.exec(config)?.[1],
    ).toBe(SEED_CHECKOUT_FLAG_KEY);
    expect(/^CHECKOUT_FLAG_KEY=(.+)$/m.exec(example)?.[1]?.trim()).toBe(
      SEED_CHECKOUT_FLAG_KEY,
    );
  });
});
