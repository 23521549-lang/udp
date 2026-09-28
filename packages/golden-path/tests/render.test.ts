import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  APP_TOKEN,
  goldenPathFiles,
  isGoldenPathRuntime,
  PROVIDER_RELEASE,
  REGISTRY_TOKEN,
} from "../src/index.js";

/** Cây §11.1 (Node) và bản tương đương Python — Plan #48 AC-3 */
const NODE_TREE = [
  ".dockerignore",
  "Dockerfile",
  "README.md",
  "k8s/deployment.yaml",
  "k8s/service.yaml",
  "package.json",
  "src/app.ts",
  "src/index.ts",
  "src/routes/hello.ts",
  "src/telemetry.ts",
  "tests/app.test.ts",
  "tsconfig.json",
];
const PYTHON_TREE = [
  ".dockerignore",
  "Dockerfile",
  "README.md",
  "app/__init__.py",
  "app/main.py",
  "app/telemetry.py",
  "k8s/deployment.yaml",
  "k8s/service.yaml",
  "pytest.ini",
  "requirements-dev.txt",
  "requirements.txt",
  "tests/test_app.py",
];

const input = { slug: "checkout", registryRef: "ghcr.io/acme" } as const;

describe("goldenPathFiles", () => {
  it("Node: đủ cây §11.1, không còn dấu hiệu nào, slug và registry đã điền", () => {
    const files = goldenPathFiles({ ...input, runtime: "nodejs" });
    expect(files.map((f) => f.path)).toEqual(NODE_TREE);
    for (const f of files) {
      expect(f.content, f.path).not.toContain(APP_TOKEN);
      expect(f.content, f.path).not.toContain(REGISTRY_TOKEN);
      expect(f.content, f.path).not.toContain("workspace:");
    }
    const deployment = files.find((f) => f.path === "k8s/deployment.yaml");
    expect(deployment?.content).toContain(
      "image: ghcr.io/acme/checkout:bootstrap",
    );
    expect(deployment?.content).toContain("value: checkout");
    expect(deployment?.content).toContain("name: checkout-udp");
    const pkg = JSON.parse(
      files.find((f) => f.path === "package.json")?.content ?? "{}",
    ) as { name: string; dependencies: Record<string, string> };
    expect(pkg.name).toBe("checkout");
    expect(pkg.dependencies["@udp/openfeature-provider"]).toBe(
      PROVIDER_RELEASE,
    );
  });

  it("Python: cây tương đương, manifest chung với Node", () => {
    const files = goldenPathFiles({ ...input, runtime: "python" });
    expect(files.map((f) => f.path)).toEqual(PYTHON_TREE);
    const node = goldenPathFiles({ ...input, runtime: "nodejs" });
    for (const path of ["k8s/deployment.yaml", "k8s/service.yaml"]) {
      expect(files.find((f) => f.path === path)).toEqual(
        node.find((f) => f.path === path),
      );
    }
  });

  it("chưa có registry ⇒ giữ dấu REGISTRY_REF cho developer điền", () => {
    const files = goldenPathFiles({
      ...input,
      registryRef: null,
      runtime: "python",
    });
    expect(
      files.find((f) => f.path === "k8s/deployment.yaml")?.content,
    ).toContain(`image: ${REGISTRY_TOKEN}/checkout:bootstrap`);
  });

  it("manifest lấy service.version từ nhãn phiên bản mà luồng áp image gắn (QĐ-3)", () => {
    const deployment =
      goldenPathFiles({ ...input, runtime: "nodejs" }).find(
        (f) => f.path === "k8s/deployment.yaml",
      )?.content ?? "";
    expect(deployment).toContain(
      "metadata.labels['app.kubernetes.io/version']",
    );
    expect(deployment).toContain("service.version=$(SERVICE_VERSION)");
  });

  it("chỉ Node.js và Python (§16)", () => {
    expect(isGoldenPathRuntime("nodejs")).toBe(true);
    expect(isGoldenPathRuntime("python")).toBe(true);
    expect(isGoldenPathRuntime("java")).toBe(false);
  });

  it("package.json sinh ra chỉ khai phụ thuộc mà monorepo đã cài cho chính template (không trôi)", () => {
    const own = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    ) as { devDependencies: Record<string, string> };
    const template = JSON.parse(
      readFileSync(
        new URL("../templates/node/package.json.tmpl", import.meta.url),
        "utf8",
      ),
    ) as {
      dependencies: Record<string, string>;
      devDependencies: Record<string, string>;
    };
    const outside = new Set(["@types/node", "tsx"]);
    for (const [name, version] of Object.entries({
      ...template.dependencies,
      ...template.devDependencies,
    })) {
      if (outside.has(name)) continue;
      expect(own.devDependencies[name], name).toBe(version);
    }
  });
});
