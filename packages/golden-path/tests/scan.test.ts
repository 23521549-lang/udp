import { describe, expect, it } from "vitest";
import {
  goldenPathFiles,
  SCAN_LIMITS,
  scanRepository,
  type FindingId,
  type RepoScan,
  type RepoSource,
} from "../src/index.js";

/** Repo trong bộ nhớ — cùng hợp đồng với nguồn GitHub/GitLab của Service 1 */
function repo(
  files: Record<string, string>,
  truncated = false,
): RepoSource & { reads: string[] } {
  const reads: string[] = [];
  return {
    truncated,
    reads,
    list: () => Promise.resolve(Object.keys(files)),
    read: (path) => {
      reads.push(path);
      return Promise.resolve(files[path]);
    },
  };
}

const status = (scan: RepoScan, id: FindingId) =>
  scan.findings.find((f) => f.id === id)?.status;

describe("scanRepository (§11.2)", () => {
  it("cây Golden Path của chính UDP: mọi điều kiện ok, sẵn sàng cho flag-level rollout", async () => {
    for (const runtime of ["nodejs", "python"] as const) {
      const files = Object.fromEntries(
        goldenPathFiles({ runtime, slug: "svc", registryRef: "ghcr.io/a" }).map(
          (f) => [f.path, f.content],
        ),
      );
      files[".github/workflows/udp.yml"] =
        'steps:\n  - run: curl "$UDP_WEBHOOK_URL"';
      const scan = await scanRepository(repo(files));
      expect(scan.runtime).toBe(runtime);
      expect(scan.framework).toBe(runtime === "nodejs" ? "express" : "fastapi");
      expect(scan.cicdTool).toBe("github-actions");
      expect(
        scan.findings.filter((f) => f.status !== "ok").map((f) => f.id),
        runtime,
      ).toEqual([]);
      expect(scan.flagLevelReady).toBe(true);
    }
  });

  it("repo Express có sẵn chưa tích hợp: thiếu gì đề xuất nấy, kèm tệp mẫu đúng runtime", async () => {
    const scan = await scanRepository(
      repo({
        "package.json": JSON.stringify({
          dependencies: { express: "^4", "prom-client": "^15" },
        }),
        "src/server.ts": "import express from 'express';",
        "deploy/app.yaml": "kind: Deployment\nspec: {}",
        ".gitlab-ci.yml": "test: { script: [npm test] }",
        "node_modules/x/package.json": "{}",
      }),
    );
    expect(scan).toMatchObject({
      runtime: "nodejs",
      framework: "express",
      cicdTool: "gitlab-ci",
    });
    expect(status(scan, "dockerfile")).toBe("missing");
    expect(status(scan, "metrics-endpoint")).toBe("ok");
    expect(status(scan, "openfeature")).toBe("missing");
    expect(status(scan, "udp-provider")).toBe("missing");
    expect(status(scan, "udp-middleware")).toBe("missing");
    expect(status(scan, "service-version")).toBe("missing");
    expect(status(scan, "pipeline")).toBe("missing");
    expect(scan.flagLevelReady).toBe(false);
    const dockerfile = scan.findings.find((f) => f.id === "dockerfile");
    expect(dockerfile?.suggestion?.file?.path).toBe("Dockerfile");
    expect(dockerfile?.suggestion?.file?.content).toContain("node:22-alpine");
  });

  it("Python có provider nhưng thiếu middleware ⇒ chưa sẵn sàng", async () => {
    const scan = await scanRepository(
      repo({
        "requirements.txt": "flask>=3\nudp-openfeature>=0.1\nopenfeature-sdk\n",
        "app.py": "from udp_openfeature import UDPFeatureFlagProvider\n",
        Dockerfile: "FROM python:3.12",
      }),
    );
    expect(scan).toMatchObject({
      runtime: "python",
      framework: "flask",
      cicdTool: null,
    });
    expect(status(scan, "udp-provider")).toBe("ok");
    expect(status(scan, "udp-middleware")).toBe("missing");
    expect(status(scan, "service-version")).toBe("unknown");
    expect(scan.flagLevelReady).toBe(false);
  });

  it("repo rỗng hay ngôn ngữ khác: runtime thiếu, đề xuất nói rõ giới hạn §16", async () => {
    const empty = await scanRepository(repo({ "README.md": "#" }));
    expect(empty.runtime).toBeNull();
    expect(status(empty, "runtime")).toBe("missing");
    const java = await scanRepository(
      repo({ "pom.xml": "<artifactId>spring-boot</artifactId>" }),
    );
    expect(java).toMatchObject({ runtime: "java", framework: "spring-boot" });
    expect(
      java.findings.find((f) => f.id === "dockerfile")?.suggestion?.file,
    ).toBeUndefined();
  });

  it("repo lớn hơn trần: không đọc quá trần, và 'không thấy middleware' là unknown chứ không phải missing", async () => {
    const files: Record<string, string> = {
      "package.json": JSON.stringify({
        dependencies: { "@udp/openfeature-provider": "^0.1.0" },
      }),
    };
    for (let i = 0; i < 200; i += 1)
      files[`src/m${String(i)}.ts`] = "export {};";
    const source = repo(files, true);
    const scan = await scanRepository(source);
    expect(source.reads.length).toBeLessThanOrEqual(SCAN_LIMITS.maxReads);
    expect(status(scan, "udp-middleware")).toBe("unknown");
    expect(status(scan, "udp-provider")).toBe("ok");
    expect(scan.truncated).toBe(true);
    expect(scan.flagLevelReady).toBe(false);
  });
});
