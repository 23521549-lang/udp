import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { has, runAsync } from "../src/shell.js";

/**
 * `deploy:up` (kind) và `vm-up` hỏi công cụ TRƯỚC khi có cụm. `kubectl version` trần thoát mã 1 khi không nói được
 * với API server — trên một runner CI chưa có kubeconfig, bước kiểm công cụ từng báo "thiếu kubectl" dù nó có mặt.
 */

const saved = process.env["KUBECONFIG"];
afterEach(() => {
  if (saved === undefined) delete process.env["KUBECONFIG"];
  else process.env["KUBECONFIG"] = saved;
});

describe("has", () => {
  it("kubectl có mặt được nhận ra kể cả khi chưa có cụm nào để nói chuyện", () => {
    process.env["KUBECONFIG"] = "/khong-co-kubeconfig-nao-o-day";
    expect(has("kubectl")).toBe(true);
  });

  it("lệnh không tồn tại là không có", () => {
    expect(has("udp-lenh-khong-ton-tai")).toBe(false);
  });
});

/**
 * [Plan #64 64f] Chờ một lệnh con mà tiến trình vẫn phục vụ được server của chính nó.
 *
 * Đúng hình dạng của test sao lưu trên máy ảo: bồn nhận HTTP sống trong tiến trình test, container
 * curl đẩy bản dump vào đó trong lúc test chờ `kubectl wait`. Ở đây tiến trình con đóng vai cả hai:
 * nó PUT 3 MiB (trên ngưỡng `Expect: 100-continue` của curl) rồi thoát 0 khi nhận 200. Chờ bằng
 * `run` (spawnSync) thì server không đọc được gì, con hết hạn của chính nó và thoát 2 - ô này đỏ
 * sạch chứ không treo, vì timer của vitest cũng đứng cùng event loop.
 */
const UPLOAD_BYTES = 3 * 1024 * 1024;
const UPLOADER = `
const [port, bytes] = process.argv.slice(1).map(Number);
fetch("http://127.0.0.1:" + port + "/udp-Sat.dump", {
  method: "PUT",
  body: Buffer.alloc(bytes, 7),
  signal: AbortSignal.timeout(5000),
}).then(
  (res) => process.exit(res.status === 200 ? 0 : 1),
  () => process.exit(2),
);
`;

describe("runAsync", () => {
  it("server trong cùng tiến trình nhận đủ upload trong lúc chờ lệnh con", async () => {
    const received: Buffer[] = [];
    const server = createServer((req, res) => {
      req.on("data", (c: Buffer) => received.push(c));
      req.on("end", () => res.writeHead(200).end());
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const { port } = server.address() as AddressInfo;
    try {
      await runAsync(process.execPath, [
        "-e",
        UPLOADER,
        String(port),
        String(UPLOAD_BYTES),
      ]);
      expect(Buffer.concat(received).length).toBe(UPLOAD_BYTES);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it("thoát khác 0 ⇒ reject kèm câu lệnh và mã", async () => {
    await expect(
      runAsync(process.execPath, ["-e", "process.exit(3)"]),
    ).rejects.toThrow(/thoát mã 3/);
  });

  it("lệnh không tồn tại ⇒ reject, không treo chờ một `exit` không bao giờ tới", async () => {
    await expect(runAsync("udp-lenh-khong-ton-tai", [])).rejects.toThrow(
      /ENOENT/,
    );
  });
});
