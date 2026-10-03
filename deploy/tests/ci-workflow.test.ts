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

  it("build-smoke: sinh đoạn build của UDP rồi chạy CHÍNH nó, rồi chạy image; đủ sáu ứng dụng mẫu; không cho PR (Plan #61)", () => {
    const smoke = job("build-smoke") as Job & {
      permissions?: Record<string, string>;
      strategy?: { matrix?: { app?: string[] } };
    };
    expect(smoke.if).toBe("github.event_name != 'pull_request'");
    expect(smoke.permissions).toEqual({
      contents: "read",
      packages: "write",
    });
    expect(smoke.strategy?.matrix?.app).toEqual([
      "node",
      "python",
      "go",
      "java-maven",
      "dotnet",
      "dockerfile",
    ]);
    const order = [
      "scripts/build-smoke.ts",
      'bash "$RUNNER_TEMP/build.sh"',
      "/healthz",
    ].map((command) => indexOfRun(smoke, command));
    expect(order.every((i) => i > -1)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    // Mỗi ứng dụng mẫu có thư mục thật
    for (const app of smoke.strategy?.matrix?.app ?? []) {
      expect(
        existsSync(
          resolve(root, "services/core-backend/tests/fixtures/build-apps", app),
        ),
        app,
      ).toBe(true);
    }
  });

  it("signing-e2e: registry có và không có API referrers ghim digest; ký bằng đoạn shell của UDP rồi mới kiểm bằng cosign, skopeo và cổng deploy, cả ca hỏng (Plan #61)", () => {
    const e2e = job("signing-e2e") as Job & {
      services?: Record<string, { image: string }>;
    };
    expect(Object.keys(e2e.services ?? {}).sort()).toEqual([
      "distribution",
      "zot",
    ]);
    for (const service of Object.values(e2e.services ?? {})) {
      expect(service.image).toMatch(/@sha256:[0-9a-f]{64}$/);
    }
    expect(e2e.env?.BASE).toMatch(/@sha256:[0-9a-f]{64}$/);
    const order = [
      "$E2E tools",
      "skopeo copy",
      '$E2E sign > "$RUNNER_TEMP/sign.sh"',
      '"$UDP_TMP/cosign" verify',
      "use-sigstore-attachments: true",
      "$E2E verify",
    ].map((command) => indexOfRun(e2e, command));
    expect(order.every((i) => i > -1)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    const gate = e2e.steps[indexOfRun(e2e, "$E2E verify")]?.run ?? "";
    for (const outcome of [
      " ok",
      " SIGNATURE_INVALID",
      " SIGNATURE_MISMATCH",
    ]) {
      expect(gate).toContain(outcome);
    }
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

/** [Plan #61 QĐ-13] Kiểm phiên bản công cụ ghim: workflow riêng, theo tuần, chỉ đọc, đỏ khi có việc cần làm */
describe("Toolchain (toolchain:check)", () => {
  const toolchain = parse(
    readFileSync(resolve(root, ".github/workflows/toolchain.yml"), "utf8"),
  ) as Workflow & { permissions?: Record<string, string> };
  const rootPackage = JSON.parse(
    readFileSync(resolve(root, "package.json"), "utf8"),
  ) as { scripts: Record<string, string> };

  it("chạy thứ Hai hằng tuần và chạy tay được; không chạy theo push hay PR", () => {
    expect(toolchain.on).toEqual({
      schedule: [{ cron: "0 2 * * 1" }],
      workflow_dispatch: null,
    });
  });

  it("chỉ đọc mã; gọi đúng lệnh gốc với GITHUB_TOKEN cho API GitHub", () => {
    expect(toolchain.permissions).toEqual({ contents: "read" });
    const check = toolchain.jobs["toolchain-check"];
    const step = check?.steps.find((s) => s.run === "pnpm toolchain:check");
    expect(step).toBeDefined();
    expect((step as Step & { env?: Record<string, string> }).env).toEqual({
      GITHUB_TOKEN: "${{ github.token }}",
    });
    expect(rootPackage.scripts["toolchain:check"]).toBe(
      "tsx packages/config/scripts/toolchain-check.ts",
    );
    expect(
      existsSync(resolve(root, "packages/config/scripts/toolchain-check.ts")),
    ).toBe(true);
  });
});

/**
 * [Plan #62 62b-4] Hai workflow phát hành SDK. AC-3 ("không token dài hạn nào") và AC-4 ("không có đường nào để
 * một lượt chạy tay phát hành thật") là mệnh đề về CẤU TRÚC của hai tệp, nên chúng được kiểm ở đây chứ không giao
 * cho `actionlint`: actionlint kiểm cú pháp và biểu thức, và một bản dựng thử đúng hình dạng "dispatch publish
 * thật" cho nó exit 0.
 *
 * Kiểm trên YAML đã `parse()`, không regex trên văn bản thô — bài học `chartPinsOf` của Plan #61.
 */
describe("Publish SDK (Plan #62)", () => {
  type Full = Workflow & {
    permissions?: Record<string, string>;
    jobs: Record<
      string,
      Job & {
        needs?: string | string[];
        permissions?: Record<string, string>;
      }
    >;
  };
  const read = (file: string): { text: string; parsed: Full } => {
    const text = readFileSync(resolve(root, ".github/workflows", file), "utf8");
    return { text, parsed: parse(text) as Full };
  };
  const publish = read("publish.yml");
  const rehearsal = read("publish-rehearsal.yml");
  const PUBLISHERS = ["npm", "pypi"];

  it("tệp phát hành chỉ chạy theo tag `sdk-v*`, KHÔNG có workflow_dispatch", () => {
    expect(publish.parsed.on).toEqual({ push: { tags: ["sdk-v*"] } });
  });

  it("tệp diễn tập chỉ chạy tay, và KHÔNG job nào của nó có id-token hay environment", () => {
    expect(Object.keys(rehearsal.parsed.on)).toEqual(["workflow_dispatch"]);
    for (const [name, job] of Object.entries(rehearsal.parsed.jobs)) {
      expect(job.permissions?.["id-token"], name).toBeUndefined();
      expect(job.environment, name).toBeUndefined();
    }
  });

  it("cả hai tệp có sàn `contents: read` ở cấp workflow, và MỌI job khai permissions", () => {
    for (const { parsed } of [publish, rehearsal]) {
      expect(parsed.permissions).toEqual({ contents: "read" });
      for (const [name, job] of Object.entries(parsed.jobs)) {
        expect(
          job.permissions,
          `job ${name} phải khai permissions`,
        ).toBeDefined();
      }
    }
  });

  it("đúng HAI job cầm id-token, chúng là npm và pypi, và mỗi cái một environment riêng", () => {
    const withToken = Object.entries(publish.parsed.jobs)
      .filter(([, job]) => job.permissions?.["id-token"] === "write")
      .map(([name]) => name)
      .sort();
    expect(withToken).toEqual(PUBLISHERS);
    const environments = PUBLISHERS.map(
      (name) => publish.parsed.jobs[name]?.environment,
    );
    // Hai environment RỜI NHAU: một environment chung thì một lượt duyệt mở cả hai registry, và hai trusted
    // publisher không thể ràng vào hai ràng buộc khác nhau
    expect(environments).toEqual(["release-npm", "release-pypi"]);
    expect(new Set(environments).size).toBe(2);
  });

  it("pypi chạy SAU npm: phía có nhiều cửa từ chối phía client hơn đi trước", () => {
    const needs = publish.parsed.jobs["pypi"]?.needs;
    expect(Array.isArray(needs) ? needs : [needs]).toContain("npm");
  });

  it("không tệp nào nhắc `secrets.` — đường phát hành không có token dài hạn", () => {
    for (const { parsed } of [publish, rehearsal]) {
      expect(JSON.stringify(parsed)).not.toMatch(/secrets\./);
    }
  });

  it("bước publish npm có --provenance và --access public", () => {
    const step = publish.parsed.jobs["npm"]?.steps.find((s) =>
      s.run?.includes("npm publish"),
    );
    expect(step?.run).toContain("--provenance");
    expect(step?.run).toContain("--access public");
  });

  it("npm được ghim một version tường minh, không `latest`", () => {
    const step = publish.parsed.jobs["npm"]?.steps.find((s) =>
      s.run?.startsWith("npm install -g npm@"),
    );
    // Trusted publishing cần npm ≥ 11.5.1 mà dòng Node 22 chỉ kèm 10.9.x; `@latest` là một tarball không ghim
    // tải vào đúng job đang cầm quyền publish
    expect(step?.run).toMatch(/^npm install -g npm@\d+\.\d+\.\d+\b/);
    expect(step?.run).not.toContain("@latest");
  });

  it("action bên thứ ba trong job cầm id-token ghim SHA 40 ký tự", () => {
    const own = /^(actions|pnpm)\//;
    for (const name of PUBLISHERS) {
      for (const step of publish.parsed.jobs[name]?.steps ?? []) {
        const uses = step.uses;
        if (uses === undefined || own.test(uses)) continue;
        expect(uses, `${name}: ${uses}`).toMatch(/@[0-9a-f]{40}$/);
      }
    }
  });

  it("bước phát hành PyPI khai attestations và skip-existing tường minh", () => {
    const step = publish.parsed.jobs["pypi"]?.steps.find((s) =>
      s.uses?.startsWith("pypa/gh-action-pypi-publish@"),
    );
    expect(step?.with).toMatchObject({
      attestations: true,
      "skip-existing": true,
    });
  });

  it("cổng chạy script version dùng chung, và script đó tồn tại", () => {
    const gate = publish.parsed.jobs["gate"];
    expect(
      gate?.steps.some(
        (s) => s.run?.includes("scripts/sdk-version.ts") === true,
      ),
    ).toBe(true);
    expect(
      existsSync(resolve(root, "packages/design-lint/scripts/sdk-version.ts")),
    ).toBe(true);
    // Cổng KHÔNG chạy lại bộ test của hai gói (chúng cần database và ô chéo ngôn ngữ bỏ qua im lặng) — nó khẳng
    // định `ci.yml` đã xanh trên đúng commit được tag
    expect(
      gate?.steps.some((s) => s.run?.includes("gh run list") === true),
    ).toBe(true);
  });
});
