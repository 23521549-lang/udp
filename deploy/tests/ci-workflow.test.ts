import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

/**
 * Plan #50 AC-4 — nối dây của CI theo §13.5. Workflow chỉ chạy được trên GitHub, nên một lỗi thụt lề hay một
 * bước đặt sai chỗ chỉ lộ ra SAU khi push; test này bắt những điều đó tại chỗ.
 */

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

interface Step {
  name?: string;
  uses?: string;
  run?: string;
  if?: string;
  with?: Record<string, unknown>;
}
interface Job {
  if?: string;
  steps: Step[];
}

const workflow = parse(
  readFileSync(resolve(root, ".github/workflows/ci.yml"), "utf8"),
) as { on: Record<string, unknown>; jobs: Record<string, Job> };
const job = (name: string): Job => {
  const found = workflow.jobs[name];
  if (found === undefined) throw new Error(`thiếu job ${name}`);
  return found;
};
const indexOfRun = (j: Job, command: string): number =>
  j.steps.findIndex((s) => s.run?.includes(command) === true);
const NIGHTLY = /schedule/;

describe("CI (§13.5)", () => {
  it("có làn đêm và làn chạy tay", () => {
    expect(Object.keys(workflow.on)).toEqual(
      expect.arrayContaining([
        "push",
        "pull_request",
        "schedule",
        "workflow_dispatch",
      ]),
    );
  });

  it("I28 chạy trên push/PR với TOÀN BỘ lịch sử — thiếu nó thì khoảng commit không giải được", () => {
    const i28 = job("i28");
    expect(i28.if).toMatch(/push/);
    expect(i28.if).toMatch(/pull_request/);
    const checkout = i28.steps.find((s) =>
      s.uses?.startsWith("actions/checkout"),
    );
    expect(checkout?.with?.["fetch-depth"]).toBe(0);
    expect(
      indexOfRun(i28, "pnpm --filter @udp/design-lint i28"),
    ).toBeGreaterThan(-1);
  });

  it("kind: dựng cụm bằng ĐÚNG lệnh của developer rồi mới E2E; E9 chỉ ở làn đêm/chạy tay", () => {
    const kind = job("kind");
    expect(kind.if).toBeUndefined();
    const up = indexOfRun(kind, "pnpm deploy:up");
    const e2e = indexOfRun(kind, "pnpm --filter @udp/deploy e2e");
    const e9 = indexOfRun(kind, "pnpm --filter @udp/experiments e9");
    expect(up).toBeGreaterThan(-1);
    expect(e2e).toBeGreaterThan(up);
    expect(e9).toBeGreaterThan(e2e);
    expect(kind.steps[e2e]?.if).toBeUndefined();
    expect(kind.steps[e9]?.if).toMatch(NIGHTLY);
    expect(kind.steps[e9]?.if).not.toMatch(/push|pull_request/);
  });

  it("kết quả E9 thành artifact từ đúng thư mục mà harness ghi; khi đỏ thì in chẩn đoán cụm", () => {
    const kind = job("kind");
    const upload = kind.steps.find((s) =>
      s.uses?.startsWith("actions/upload-artifact"),
    );
    expect(upload?.if).toMatch(NIGHTLY);
    const path = String(upload?.with?.["path"]);
    expect(path).toBe("docs/measurements/raw/E9-*.json");
    expect(existsSync(resolve(root, dirname(path)))).toBe(true);
    const diagnose = kind.steps.find((s) =>
      s.run?.includes("@udp/deploy diagnose"),
    );
    expect(diagnose?.if).toBe("failure()");
  });
});
