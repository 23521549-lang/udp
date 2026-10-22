import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { inClusterApi } from "../src/in-cluster/api.js";

/** [Plan #67] Dò API server của cụm từ môi trường của pod - thư mục ServiceAccount giả trên đĩa */

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "udp-sa-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const writeSa = async () => {
  await writeFile(join(dir, "ca.crt"), "-----BEGIN CERTIFICATE-----\n");
  await writeFile(join(dir, "namespace"), "udp\n");
  await writeFile(join(dir, "token"), "tok-1\n");
};

describe("inClusterApi (Plan #67)", () => {
  it("không có KUBERNETES_SERVICE_HOST ⇒ ngoài cụm", async () => {
    await writeSa();
    expect(await inClusterApi({}, dir)).toEqual({
      kind: "outside",
      reason: "NO_SERVICE_HOST",
    });
  });

  it("có host mà thiếu tệp ServiceAccount ⇒ ngoài cụm (automountServiceAccountToken: false)", async () => {
    expect(
      await inClusterApi({ KUBERNETES_SERVICE_HOST: "10.43.0.1" }, dir),
    ).toEqual({ kind: "outside", reason: "NO_SERVICE_ACCOUNT" });
  });

  it("trong cụm: địa chỉ https, namespace, token đọc lại mỗi lần", async () => {
    await writeSa();
    const found = await inClusterApi(
      { KUBERNETES_SERVICE_HOST: "10.43.0.1", KUBERNETES_SERVICE_PORT: "6443" },
      dir,
    );
    if (found.kind !== "in-cluster") throw new Error(found.reason);
    expect(found.api.apiServer).toBe("https://10.43.0.1:6443");
    expect(found.api.namespace).toBe("udp");
    expect(await found.api.token()).toBe("tok-1");
    await writeFile(join(dir, "token"), "tok-2\n");
    expect(await found.api.token()).toBe("tok-2");
  });

  it("IPv6 trong ngoặc vuông, cổng mặc định 443", async () => {
    await writeSa();
    const found = await inClusterApi(
      { KUBERNETES_SERVICE_HOST: "fd00::1" },
      dir,
    );
    if (found.kind !== "in-cluster") throw new Error(found.reason);
    expect(found.api.apiServer).toBe("https://[fd00::1]:443");
  });
});
