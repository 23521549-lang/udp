import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  APP_TOKEN,
  goldenPathFiles,
  isGoldenPathRuntime,
  PROVIDER_PUBLIC_NAME,
  PROVIDER_RELEASE,
  REGISTRY_TOKEN,
} from "../src/index.js";

/** Ghép qua hằng — một literal `@udp/…` ở đây bị luật ranh giới đọc như một phụ thuộc thật */
const UDP_SCOPE = ["@udp", ""].join("/");
const IN_REPO_NAME = `${UDP_SCOPE}openfeature-provider`;

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
    /**
     * [Plan #62 62d-5] Khoá đổi sang tên PHÁT HÀNH, nhưng phép khẳng định ghim version **giữ nguyên**. Xoá ô này
     * rồi tin rằng "cây sinh ra không còn `@udp/`" đã thay thế là một thoái cấp: ô phủ định đó không kiểm khoá tên
     * là gì, cũng không kiểm nó ghim `PROVIDER_RELEASE`.
     */
    expect(pkg.dependencies[PROVIDER_PUBLIC_NAME]).toBe(PROVIDER_RELEASE);
    expect(pkg.dependencies[IN_REPO_NAME]).toBeUndefined();
  });

  /**
   * [Plan #62 62d-5] Cây sinh cho khách phải cài được: không một chuỗi `@udp/` nào (namespace CỦA KHO, không gói
   * nào của nó có trên registry), và mọi specifier provider phải thuộc tập subpath ĐÃ PHÁT HÀNH.
   *
   * Nửa phủ định một mình là một cổng yếu — nó xanh cả khi template bỏ hẳn provider. Nên có cả nửa dương, và
   * `"udp-openfeature": "^0.1.0"` được khẳng định như MỘT chuỗi: nó đỏ nếu thiếu phép thay tên, đỏ nếu thiếu phép
   * thay version, và đỏ nếu một ngày thứ tự hai phép thay trở nên load-bearing rồi bị đảo.
   */
  it("[Plan #62] cây sinh ra dùng tên PHÁT HÀNH, không còn tên trong kho", () => {
    for (const runtime of ["nodejs", "python"] as const) {
      const files = goldenPathFiles({ ...input, runtime });
      const leaked = files.filter((f) => f.content.includes(UDP_SCOPE));
      expect(
        leaked.map((f) => f.path),
        runtime,
      ).toEqual([]);
    }

    const node = goldenPathFiles({ ...input, runtime: "nodejs" });
    expect(node.find((f) => f.path === "package.json")?.content).toContain(
      `"${PROVIDER_PUBLIC_NAME}": "${PROVIDER_RELEASE}"`,
    );
    expect(node.find((f) => f.path === "src/telemetry.ts")?.content).toContain(
      `from "${PROVIDER_PUBLIC_NAME}"`,
    );
    expect(node.find((f) => f.path === "src/app.ts")?.content).toContain(
      `from "${PROVIDER_PUBLIC_NAME}/metrics"`,
    );

    const subpaths = new Set<string>();
    for (const f of node) {
      for (const m of f.content.matchAll(
        new RegExp(`${PROVIDER_PUBLIC_NAME}((?:\\/[a-z-]+)*)`, "g"),
      )) {
        subpaths.add(m[1] ?? "");
      }
    }
    expect([...subpaths].sort()).toEqual(["", "/metrics"]);
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
