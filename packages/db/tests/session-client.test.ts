import { randomUUID } from "node:crypto";
import { createServer, type Server, type Socket } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createSessionConnector } from "../src/session.js";
import { connectionString, openClient } from "./helpers/db.js";

/**
 * `createSessionConnector` gói những cái bẫy của `pg` đã đo trên đường LISTEN.
 * Hai nửa, hai loại bằng chứng:
 *
 *   - Một máy chủ TCP nhận kết nối rồi IM LẶNG mãi mãi, kể cả khi bị đóng một
 *     chiều (`allowHalfOpen`) — đúng hình dạng "kết nối chết im". Không database
 *     nào tái hiện được ca đó theo lệnh, nên dựng nó ra.
 *   - Database thật: interface hẹp không được làm mất gì của `pg` — LISTEN nhận
 *     được, và client chết vì `pg_terminate_backend` báo `end` ĐÚNG MỘT lần.
 */

async function waitFor(
  ok: () => boolean,
  ms: number,
  what: string,
): Promise<void> {
  const deadline = Date.now() + ms;
  while (!ok()) {
    if (Date.now() > deadline) throw new Error(`Hết ${String(ms)}ms: ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

const uniqueChannel = (): string =>
  `udp_probe_${randomUUID().replaceAll("-", "")}`;

describe("máy chủ im lặng — mọi thao tác có hạn, quá hạn thì huỷ socket", () => {
  let server: Server | undefined;
  /** Mọi socket phía máy chủ — để dọn */
  const accepted = new Set<Socket>();
  /** Socket mà phía client CHƯA đóng chiều của nó */
  const peerOpen = new Set<Socket>();
  let silentUrl = "";

  beforeAll(async () => {
    const silent = createServer({ allowHalfOpen: true }, (socket) => {
      accepted.add(socket);
      peerOpen.add(socket);
      const peerClosed = (): void => {
        peerOpen.delete(socket);
      };
      // `allowHalfOpen`: máy chủ không bao giờ tự đóng chiều của nó, nên `close`
      // không tới — `end` mới là lúc client đã đóng. `resume` để đọc bỏ những gì
      // client gửi: luồng còn dữ liệu chưa đọc thì `end` không bao giờ bắn
      socket.on("end", peerClosed);
      socket.on("error", peerClosed);
      socket.on("close", () => {
        peerClosed();
        accepted.delete(socket);
      });
      socket.resume();
    });
    server = silent;
    await new Promise<void>((resolve) => {
      silent.listen(0, "127.0.0.1", resolve);
    });
    const address = silent.address();
    if (address === null || typeof address === "string") {
      throw new Error("Không đọc được cổng của máy chủ im lặng");
    }
    silentUrl = `postgresql://udp_probe:khong-dung@127.0.0.1:${String(address.port)}/postgres`;
  });

  afterAll(async () => {
    for (const socket of accepted) socket.destroy();
    const silent = server;
    if (silent === undefined) return; // beforeAll ném trước khi dựng xong
    await new Promise<void>((resolve) => {
      silent.close(() => {
        resolve();
      });
    });
  });

  it("connect quá hạn ⇒ ném, socket bị huỷ, end bắn đúng một lần", async () => {
    const client = createSessionConnector(silentUrl)();
    let ends = 0;
    client.onceEnd(() => {
      ends += 1;
    });

    const started = Date.now();
    await expect(client.connect(300)).rejects.toThrow("quá 300ms");
    expect(Date.now() - started).toBeLessThan(2_000);

    await waitFor(() => ends === 1, 2_000, "end không bắn sau khi huỷ socket");
    await waitFor(
      () => peerOpen.size === 0,
      2_000,
      "phía máy chủ không thấy client đóng kết nối",
    );

    // Đóng một client đã chết: không ném, không treo, không bắn end lần hai
    await client.close(300);
    expect(ends).toBe(1);
  });

  it("close giữa lúc đang nối ⇒ lần nối hỏng NGAY, không treo tới hết hạn của nó", async () => {
    /**
     * `pg` bỏ qua callback của lần nối khi client đã `_ending`, nên `end()` giữa
     * lúc nối làm `connect()` treo trọn hạn chờ của nó — đã đo: 10 giây. `close`
     * phải huỷ socket ở trạng thái này.
     */
    const client = createSessionConnector(silentUrl)();
    const connecting = client.connect(10_000);

    const started = Date.now();
    await client.close(300);
    await expect(connecting).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(2_000);
  });
});

describe("database thật", () => {
  it("currentUser đọc đúng role mà pg trần thấy", async () => {
    const reference = await openClient();
    let expected: string | undefined;
    try {
      const rows = await reference.query<{ current_user: string }>(
        "SELECT current_user",
      );
      expected = rows.rows[0]?.current_user;
    } finally {
      await reference.end();
    }

    const client = createSessionConnector(connectionString())();
    try {
      await client.connect(10_000);
      expect(await client.currentUser(10_000)).toBe(expected);
    } finally {
      await client.close(5_000);
    }
  });

  it("LISTEN nhận notification; close êm; end bắn đúng một lần", async () => {
    const client = createSessionConnector(connectionString())();
    const received: [string, string | undefined][] = [];
    let ends = 0;
    client.onNotification((channel, payload) => {
      received.push([channel, payload]);
    });
    client.onceEnd(() => {
      ends += 1;
    });

    await client.connect(10_000);
    // Kênh riêng của lần chạy này — không lẫn với writer thật trên `flag_changed`
    const channel = uniqueChannel();
    await client.listen(channel, 10_000);
    await client.ping(10_000);

    const sender = await openClient();
    try {
      await sender.query("SELECT pg_notify($1, $2)", [channel, "xin chào"]);
    } finally {
      await sender.end();
    }

    await waitFor(() => received.length > 0, 5_000, "notification không tới");
    expect(received).toEqual([[channel, "xin chào"]]);

    await client.close(5_000);
    await waitFor(() => ends === 1, 2_000, "end không bắn sau close");
  });

  it("pg_terminate_backend ⇒ end ĐÚNG MỘT lần, dù pg phát error trước đó", async () => {
    const client = createSessionConnector(connectionString())();
    const errors: string[] = [];
    let ends = 0;
    client.onError((err) => {
      errors.push(err.message);
    });
    client.onceEnd(() => {
      ends += 1;
    });

    await client.connect(10_000);
    const channel = uniqueChannel();
    await client.listen(channel, 10_000);

    const admin = await openClient();
    try {
      // Tìm đúng backend của client này qua câu lệnh cuối của nó — kênh là duy nhất
      const killed = await admin.query<{ ok: boolean }>(
        "SELECT pg_terminate_backend(pid) AS ok FROM pg_stat_activity WHERE query = $1",
        [`LISTEN "${channel}"`],
      );
      expect(killed.rows.map((r) => r.ok)).toEqual([true]);
    } finally {
      await admin.end();
    }

    await waitFor(() => ends === 1, 5_000, "end không bắn khi backend chết");
    expect(errors.length).toBeGreaterThan(0);

    // Không có `end` thứ hai tới muộn
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(ends).toBe(1);
    await client.close(1_000);
  });
});
