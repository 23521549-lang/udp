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
  environment?: string;
  env?: Record<string, string>;
  steps: Step[];
}

interface Workflow {
  name: string;
  on: Record<string, unknown>;
  concurrency?: { group: string; "cancel-in-progress": boolean };
  jobs: Record<string, Job>;
}

const workflow = parse(
  readFileSync(resolve(root, ".github/workflows/ci.yml"), "utf8"),
) as Workflow;
const deployText = readFileSync(
  resolve(root, ".github/workflows/deploy.yml"),
  "utf8",
);
const deploy = parse(deployText) as Workflow;
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

  it("portal-demo: build bản xem thử, cài Chromium, rồi mới chụp; ảnh chụp lên artifact kể cả khi đỏ (Plan #53 QĐ-11)", () => {
    const demo = job("portal-demo");
    expect(demo.if).toBeUndefined();
    const order = [
      "@udp/portal demo:build",
      "playwright install --with-deps chromium",
      "@udp/portal demo:screens",
    ].map((command) => indexOfRun(demo, command));
    expect(order.every((i) => i > -1)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    const upload = demo.steps.find((s) =>
      s.uses?.startsWith("actions/upload-artifact"),
    );
    expect(upload?.if).toBe("always()");
    expect(upload?.with?.["path"]).toBe("apps/portal/demo/screens/");
    // Không secret: bản xem thử chạy hoàn toàn trong trang
    expect(JSON.stringify(demo)).not.toMatch(/secrets\./);
  });
});

describe("máy ảo công khai (Plan #52)", () => {
  it("vm: dựng máy bằng ĐÚNG bootstrap.sh, cấu hình diễn tập, phát hành bằng ĐÚNG release.sh, rồi E2E qua HTTPS", () => {
    const vm = job("vm");
    expect(vm.if).toBeUndefined();
    const order = [
      "bash deploy/vm/bootstrap.sh",
      "bash deploy/vm/ci-settings.sh",
      'bash deploy/vm/release.sh "$GITHUB_SHA"',
      "pnpm --filter @udp/deploy e2e:vm",
    ].map((command) => indexOfRun(vm, command));
    expect(order.every((i) => i > -1)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    const diagnose = vm.steps.find((s) =>
      s.run?.includes("diagnose --target vm"),
    );
    expect(diagnose?.if).toBe("failure()");
  });

  it("Deploy chạy sau khi CI XANH cho một lần push lên main, hay chạy tay", () => {
    const run = deploy.on["workflow_run"] as {
      workflows: string[];
      types: string[];
      branches: string[];
    };
    expect(run.workflows).toEqual([workflow.name]);
    expect(run.types).toEqual(["completed"]);
    expect(run.branches).toEqual(["main"]);
    expect(Object.keys(deploy.on)).toContain("workflow_dispatch");
    const vm = deploy.jobs["vm"];
    expect(vm?.if).toContain("workflow_run.conclusion == 'success'");
    expect(vm?.if).toContain("workflow_run.event == 'push'");
    expect(vm?.environment).toBe("vm");
    // Lượt đang chạy có thể đang giữa migrate — không huỷ
    expect(deploy.concurrency?.["cancel-in-progress"]).toBe(false);
  });

  it("phát hành đúng commit CI đã kiểm, chỉ khi còn là đỉnh main; thiếu secret thì bỏ qua", () => {
    const vm = deploy.jobs["vm"];
    expect(vm?.env?.["RELEASE_SHA"]).toContain(
      "github.event.workflow_run.head_sha",
    );
    const checkout = vm?.steps.find((s) =>
      s.uses?.startsWith("actions/checkout"),
    );
    expect(checkout?.with?.["ref"]).toBe("${{ env.RELEASE_SHA }}");
    const ship = vm?.steps.find((s) => s.run?.includes("deploy/vm/ship.sh"));
    expect(ship?.run).toBe('bash deploy/vm/ship.sh "$RELEASE_SHA"');
    expect(ship?.if).toContain("env.UDP_VM_HOST != ''");
    expect(ship?.if).toContain("steps.tip.outputs.stale != 'true'");
  });

  it("không nội suy biểu thức vào lệnh shell, không tắt kiểm host key", () => {
    for (const step of deploy.jobs["vm"]?.steps ?? []) {
      expect(step.run ?? "", step.name).not.toContain("${{");
    }
    expect(deployText).not.toMatch(/StrictHostKeyChecking=(no|accept-new)/);
  });
});
