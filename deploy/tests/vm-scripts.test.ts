import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";
import { describe, expect, it } from "vitest";
import { parseVmSettings, RECOVERY_KEYS, vmSettingsSchema } from "../src/vm.js";

/**
 * Plan #52 AC-3 — script của máy ảo chỉ chạy được trên Linux có sudo (máy ảo, runner CI), nên ở đây kiểm những gì
 * kiểm được tại chỗ: cú pháp, từ chối SHA sai dạng TRƯỚC khi chạm máy, một nguồn phiên bản, và cấu hình mẫu/CI
 * khớp CHÍNH schema mà `vm-up` đọc.
 */

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const vmDir = resolve(root, "deploy/vm");
const read = (name: string): string =>
  readFileSync(resolve(vmDir, name), "utf8");
const SCRIPTS = ["bootstrap.sh", "release.sh", "ship.sh", "ci-settings.sh"];

const bash = (args: readonly string[], env: Record<string, string> = {}) =>
  spawnSync("bash", args, {
    encoding: "utf8",
    env: { ...process.env, ...env },
  });

describe("script của máy ảo", () => {
  it("cú pháp bash hợp lệ, và đều dừng ở lỗi đầu tiên (set -euo pipefail)", () => {
    for (const name of SCRIPTS) {
      const result = bash(["-n", resolve(vmDir, name)]);
      expect(result.status, `${name}: ${result.stderr}`).toBe(0);
      expect(read(name), name).toContain("set -euo pipefail");
    }
  });

  it("release.sh và ship.sh từ chối SHA không phải 40 ký tự hex — trước khi cài gì hay mở SSH", () => {
    for (const name of ["release.sh", "ship.sh"]) {
      for (const sha of ["", "abc123", "0".repeat(39), `${"0".repeat(39)}G`]) {
        const result = bash([resolve(vmDir, name), sha], {
          UDP_VM_HOST: "host.invalid",
          UDP_VM_USER: "nobody",
        });
        expect(result.status, `${name} "${sha}"`).toBe(2);
        expect(result.stderr).toContain("SHA");
      }
    }
  });

  it("ship.sh không bao giờ tắt kiểm host key; mã nguồn đi bằng git archive của ĐÚNG commit", () => {
    const ship = read("ship.sh");
    expect(ship).toContain("StrictHostKeyChecking=yes");
    expect(ship).not.toMatch(/StrictHostKeyChecking=(no|accept-new)/);
    expect(ship).toContain('git archive --format=tar "$sha"');
  });
});

describe("phiên bản ghim (versions.env)", () => {
  const versions = parseEnv(read("versions.env"));

  it("đủ ba phiên bản, đúng dạng; Node cùng dòng 22 với engines của repo và CI", () => {
    expect(versions["K3S_VERSION"]).toMatch(/^v\d+\.\d+\.\d+\+k3s\d+$/);
    expect(versions["CERT_MANAGER_VERSION"]).toMatch(/^v\d+\.\d+\.\d+$/);
    expect(versions["NODE_VERSION"]).toMatch(/^v22\.\d+\.\d+$/);
    const [minor = 0, patch = 0] = (versions["NODE_VERSION"] ?? "")
      .slice("v22.".length)
      .split(".")
      .map(Number);
    // engines: node >= 22.22.2 (@sigstore/verify 4 — Service 1 kiểm chữ ký image, Plan #61)
    expect(minor > 22 || (minor === 22 && patch >= 2)).toBe(true);
  });

  it("bootstrap.sh đọc CHÍNH tệp đó và dùng cả ba — không phiên bản nào viết cứng ở chỗ khác", () => {
    const bootstrap = read("bootstrap.sh");
    expect(bootstrap).toContain('source "$here/versions.env"');
    for (const key of Object.keys(versions)) {
      expect(bootstrap, key).toContain(`\${${key}}`);
    }
    expect(bootstrap).not.toMatch(/v\d+\.\d+\.\d+\+k3s/);
  });
});

describe("Traefik trước lần phát hành đầu", () => {
  it("bootstrap.sh áp CHÍNH tệp mà overlay vm áp mỗi lần phát hành — một nguồn, không hai bản lệch nhau", () => {
    expect(read("bootstrap.sh")).toContain(
      '"$here/../k8s/overlays/vm/traefik.yaml"',
    );
    const overlay = readFileSync(
      resolve(root, "deploy/k8s/overlays/vm/kustomization.yaml"),
      "utf8",
    );
    expect(overlay).toMatch(/^\s+- traefik\.yaml$/m);
  });
});

describe("cấu hình của máy", () => {
  it("vm.env.example có đúng các biến của schema — biến bắt buộc có dòng để điền, khoá khôi phục ở dạng chú thích", () => {
    const example = read("vm.env.example");
    const keys = Object.keys(parseEnv(example));
    const shape = vmSettingsSchema.shape;
    for (const key of keys) {
      expect(Object.keys(shape), key).toContain(key);
    }
    for (const [key, schema] of Object.entries(shape)) {
      if (!schema.isOptional()) expect(keys, key).toContain(key);
    }
    for (const key of RECOVERY_KEYS) {
      expect(example).toContain(`# ${key}=`);
    }
  });

  it("cấu hình mà ci-settings.sh viết cho máy diễn tập qua CHÍNH schema, với CA tự ký", () => {
    const script = read("ci-settings.sh");
    const vars: Record<string, string> = { node_ip: "10.1.0.4" };
    for (const [, name, value] of script.matchAll(/^readonly (\w+)=(.+)$/gm)) {
      if (name !== undefined && value !== undefined) vars[name] = value;
    }
    vars["HOME"] = "/home/runner";
    const body = /<<EOF\n([\s\S]*?)\nEOF/.exec(script)?.[1];
    expect(body).toBeDefined();
    const text = (body ?? "").replace(
      /\$(\w+)/g,
      (_m, name: string) => vars[name] ?? `<thiếu ${name}>`,
    );
    const settings = parseVmSettings(text);
    expect(settings.TLS_ISSUER).toBe("self-signed");
    expect(new URL(settings.UDP_BACKUP_UPLOAD_URL).port).toBe(
      vars["CI_BACKUP_SINK_PORT"],
    );
  });
});
