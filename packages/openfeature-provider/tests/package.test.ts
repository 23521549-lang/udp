import { execFile } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { packPublishArtifact } from "../scripts/pack.js";

/**
 * Gói PHÁT HÀNH của provider (§6.8) [v4.8] cài và chạy được NGOÀI monorepo: build
 * → `pnpm pack` → giải nén vào `node_modules` của một ứng dụng khách dựng trong
 * thư mục tạm của hệ điều hành → peer liên kết từ monorepo (junction: không cần
 * quyền symlink trên Windows) → khách import cả hai entry, chạy thật, typecheck.
 * Không mạng: không `npm install`.
 */

const run = promisify(execFile);
const pkgRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PEERS = ["@openfeature/server-sdk", "@openfeature/core", "prom-client"];
/**
 * Tên gói ghép qua hằng trong mã SINH cho khách: một literal import `@udp/…`
 * trong file này sẽ bị luật ranh giới đọc như provider tự import chính nó.
 */
const PKG = ["@udp", "openfeature-provider"].join("/");

/** `undefined` khi `beforeAll` hỏng trước khi tạo thư mục tạm */
let work: string | undefined;
let consumer: string;
let tarEntries: string[];

/** Gốc đã cài của một package (theo góc nhìn của provider) — đi lên tới package.json cùng tên */
function installedDir(name: string, from: string): string {
  let dir = join(from, "node_modules", ...name.split("/"));
  if (existsSync(join(dir, "package.json"))) return dir;
  dir = join(pkgRoot, "..", "..", "node_modules", ...name.split("/"));
  if (existsSync(join(dir, "package.json"))) return dir;
  throw new Error(`không thấy ${name} đã cài`);
}

beforeAll(async () => {
  work = mkdtempSync(join(tmpdir(), "udp-provider-pack-"));
  /**
   * [Plan #62 62a-5] Dùng ĐÚNG đường đóng gói mà `publish.yml` dùng (`scripts/pack.ts`: build → `pnpm pack` →
   * xoá `@udp/*` và `scripts` khỏi manifest → `npm pack` → khẳng định hợp đồng), nên thứ test này tiêu thụ là đúng
   * bytes được phát hành. Trước đây test tự build rồi tự `pnpm pack`, tức nó kiểm một tarball KHÁC.
   */
  const artifact = packPublishArtifact({ out: work });
  tarEntries = artifact.entries;
  await run("tar", ["-xzf", basename(artifact.tarball)], { cwd: work });

  consumer = join(work, "consumer");
  const modules = join(consumer, "node_modules");
  mkdirSync(join(modules, "@udp"), { recursive: true });
  mkdirSync(join(modules, "@openfeature"), { recursive: true });
  mkdirSync(join(modules, "@types"), { recursive: true });
  renameSync(
    join(work, "package"),
    join(modules, "@udp", "openfeature-provider"),
  );
  for (const peer of [...PEERS, "@types/node"]) {
    symlinkSync(
      installedDir(peer, pkgRoot),
      join(modules, ...peer.split("/")),
      "junction",
    );
  }
  writeFileSync(
    join(consumer, "package.json"),
    JSON.stringify({ name: "consumer", type: "module", private: true }),
  );
}, 180_000);

afterAll(() => {
  // Junction bị xoá như một thư mục rỗng — `rmSync` không đi xuyên vào đích
  if (work !== undefined) rmSync(work, { recursive: true, force: true });
});

describe("gói phát hành", () => {
  it("tarball chỉ có dist, manifest, giấy phép và trang gói; manifest không kéo gì của UDP; kiểu công khai không import @udp/*", () => {
    /**
     * [Plan #62] Ba tệp được phép ở GỐC tarball, không một tệp nữa. `LICENSE` và `README.md` vào bằng LUẬT của
     * npm/pnpm (chúng luôn được đưa vào, bất kể `files`), không bằng khai báo — nên tên ô cũ ("chỉ có dist +
     * manifest") đã hết đúng và được đổi, chứ không chỉ nới luật.
     *
     * Và vì sao KHÔNG khẳng định đúng tập 11 entry: `dist/chunk-*.js` mang hash nội dung trong tên, nên một tập
     * chính xác sẽ đỏ ở mọi lần đổi mã — một cổng đỏ vì lý do sai là một cổng sẽ bị tắt.
     */
    const ROOT = [
      "package/package.json",
      "package/LICENSE",
      "package/README.md",
    ];
    for (const entry of tarEntries) {
      expect(ROOT.includes(entry) || entry.startsWith("package/dist/")).toBe(
        true,
      );
    }
    expect(tarEntries).toContain("package/LICENSE");
    expect(tarEntries).toContain("package/README.md");
    expect(tarEntries).toContain("package/dist/THIRD_PARTY_NOTICES");
    expect(
      tarEntries.some((e) => e.endsWith(".map") || e.endsWith(".tsbuildinfo")),
    ).toBe(false);

    const installed = join(
      consumer,
      "node_modules",
      "@udp",
      "openfeature-provider",
    );
    const manifest = JSON.parse(
      readFileSync(join(installed, "package.json"), "utf8"),
    ) as {
      dependencies?: Record<string, string>;
      exports: Record<string, { default: string; types: string }>;
    };
    expect(manifest.dependencies ?? {}).toEqual({});
    expect(Object.keys(manifest.exports).sort()).toEqual([".", "./metrics"]);

    const types = join(installed, "dist", "types");
    const files = readdirSync(types, { recursive: true, withFileTypes: true })
      .filter((e) => e.isFile())
      .map((e) => join(e.parentPath, e.name));
    for (const file of files) {
      const text = readFileSync(file, "utf8");
      // Chỉ ĐƯỜNG DẪN import (`from "…"` và `import("…")`) — JSDoc được phép nhắc tên
      const specifiers = [
        ...text.matchAll(/(?:from\s+|import\(\s*)"([^"]+)"/g),
      ].map((m) => m[1]);
      expect(specifiers.filter((s) => s?.startsWith("@udp/"))).toEqual([]);
    }
  });

  it("khách import CẢ HAI entry: đánh giá thật qua HTTP, hook của entry chính ghi nhãn mà middleware của /metrics phát", async () => {
    writeFileSync(
      join(consumer, "run.mjs"),
      `
import { createServer } from "node:http";
import { EventEmitter } from "node:events";
import { OpenFeature } from "@openfeature/server-sdk";
import { Registry } from "prom-client";
import { UDPFeatureFlagProvider } from "${PKG}";
import { udpMetricsMiddleware } from "${PKG}/metrics";

const body = JSON.stringify({
  configVersion: 1, configHash: "", environment: "dev", trackedFlags: ["f"], segments: [],
  flags: [{ key: "f", type: "BOOLEAN", isEnabled: true, stickinessAttribute: "targetingKey",
    variants: { on: true, off: false }, defaultVariantKey: "on", rules: [] }],
});
const server = createServer((req, res) => {
  if (req.url.startsWith("/sdk/config")) {
    res.writeHead(200, { "Content-Type": "application/json", ETag: '"1"' }).end(body);
    return;
  }
  res.writeHead(200, { "Content-Type": "text/event-stream" });
  res.write(": ok\\n\\n");
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const host = "http://127.0.0.1:" + server.address().port;

await OpenFeature.setProviderAndWait(new UDPFeatureFlagProvider({ host, sdkKey: "udp_sk_x" }));
const client = OpenFeature.getClient();
const value = await client.getBooleanValue("f", false);

const registry = new Registry();
const mw = udpMetricsMiddleware({ registry, serviceName: "s", serviceVersion: "v" });
const res = Object.assign(new EventEmitter(), { statusCode: 200, headersSent: false });
await new Promise((done) => {
  mw({ method: "GET" }, res, () => {
    void (async () => {
      await client.getBooleanValue("f", false);
      res.headersSent = true;
      res.emit("finish");
      done();
    })();
  });
});
const exposition = await registry.metrics();
await OpenFeature.close();
server.closeAllConnections();
server.close();
console.log(JSON.stringify({ value, labelled: exposition.includes('ff="f=on"') }));
`,
    );
    const { stdout } = await run(process.execPath, ["run.mjs"], {
      cwd: consumer,
      timeout: 30_000,
    });
    expect(JSON.parse(stdout.trim())).toEqual({ value: true, labelled: true });
  }, 60_000);

  it("kiểu của gói typecheck ở phía khách và KHÔNG phải any", async () => {
    writeFileSync(
      join(consumer, "typed.ts"),
      `
import { UDPFeatureFlagProvider, type UDPProviderOptions } from "${PKG}";
import { udpMetricsMiddleware } from "${PKG}/metrics";

const options: UDPProviderOptions = { host: "http://h", sdkKey: "k" };
// @ts-expect-error TSX-05: host phải là chuỗi — kiểu thật, không phải any
const wrong: UDPProviderOptions = { host: 1, sdkKey: "k" };
const provider = new UDPFeatureFlagProvider(options);
// @ts-expect-error TSX-06: constructor công khai chỉ nhận MỘT tham số (chỗ tiêm test không lộ ra)
new UDPFeatureFlagProvider(options, {});
const version: number | undefined = provider.configVersion;
const middleware = udpMetricsMiddleware({ serviceName: "s" });
export { wrong, version, middleware };
`,
    );
    writeFileSync(
      join(consumer, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          target: "ES2022",
          module: "NodeNext",
          moduleResolution: "NodeNext",
          strict: true,
          noEmit: true,
          // Kiểm CẢ `.d.ts` của gói: kiểu nội bộ lộ ra (import không phân giải được)
          // thì báo lỗi ở đây, không âm thầm thành `any`
          skipLibCheck: false,
          types: ["node"],
        },
        files: ["typed.ts"],
      }),
    );
    const tsc = join(pkgRoot, "node_modules", "typescript", "bin", "tsc");
    await run(process.execPath, [tsc, "-p", "tsconfig.json"], {
      cwd: consumer,
    });
  }, 60_000);

  it("init trên BUNDLE: Service 2 không tới được ⇒ tiến trình sống tới lúc init hết hạn", async () => {
    writeFileSync(
      join(consumer, "probe.mjs"),
      `
import { OpenFeature } from "@openfeature/server-sdk";
import { UDPFeatureFlagProvider } from "${PKG}";
const provider = new UDPFeatureFlagProvider({
  host: "http://127.0.0.1:9", sdkKey: "k", initTimeoutMs: 300,
  fetch: () => Promise.reject(new TypeError("fetch failed")),
});
try { await OpenFeature.setProviderAndWait(provider); console.log("init resolved"); }
catch { console.log("init rejected"); }
await OpenFeature.close();
`,
    );
    const { stdout } = await run(process.execPath, ["probe.mjs"], {
      cwd: consumer,
      timeout: 30_000,
    });
    expect(stdout).toContain("init rejected");
  }, 60_000);
});
