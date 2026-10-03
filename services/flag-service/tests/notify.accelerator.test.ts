import type { SessionClient } from "@udp/db";
import {
  CONFIG_CHANGE_CHANNEL,
  formatConfigChangeNotice,
} from "@udp/shared-types/change-feed";
import { describe, expect, it } from "vitest";
import { createNotifyAccelerator } from "../src/changefeed/notify.accelerator.js";

/**
 * Phần riêng của tầng 3 — đọc notice và lọc theo environment replica đang giữ.
 * Máy trạng thái của kênh (nối lại, ping, sai role, dừng) kiểm ở
 * `packages/db/tests/listen-accelerator.test.ts`.
 */

const HELD = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OTHER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

type Handler = (channel: string, payload: string | undefined) => void;

/** Client đủ để kênh nối xong một lần; test tự phát notification */
function fakeClient(): { client: SessionClient; emit: Handler } {
  let handler: Handler = () => undefined;
  const client: SessionClient = {
    connect: () => Promise.resolve(),
    currentUser: () => Promise.resolve("udp_s2"),
    listen: () => Promise.resolve(),
    ping: () => Promise.resolve(),
    onNotification: (h) => {
      handler = h;
    },
    onError: () => undefined,
    onceEnd: () => undefined,
    close: () => Promise.resolve(),
  };
  return { client, emit: (c, p) => handler(c, p) };
}

async function listening(
  holds: (environmentId: string) => boolean,
): Promise<{ emit: Handler; wakes: () => number; stop: () => Promise<void> }> {
  const fake = fakeClient();
  let wakes = 0;
  const accelerator = createNotifyAccelerator({
    connect: () => fake.client,
    expectedRole: "udp_s2",
    holds,
    wake: () => {
      wakes += 1;
    },
  });
  accelerator.start();
  // Nối, đọc role, LISTEN rồi `onListening` — mỗi bước một `await` trên client
  // giả đã resolve; mười vòng microtask là biên rộng cho chuỗi đó
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
  return {
    emit: fake.emit,
    wakes: () => wakes,
    stop: () => accelerator.stop(),
  };
}

const noticeFor = (environmentId: string): string =>
  formatConfigChangeNotice({ environmentId, configVersion: 9 });

describe("tầng 3 — đọc notice", () => {
  it("nghe được thì đánh thức MỘT lần; sau đó chỉ notice hợp lệ của environment đang giữ mới đánh thức", async () => {
    const r = await listening((id) => id === HELD);
    expect(r.wakes()).toBe(1);

    r.emit(CONFIG_CHANGE_CHANNEL, noticeFor(HELD));
    expect(r.wakes()).toBe(2);

    r.emit(CONFIG_CHANGE_CHANNEL, noticeFor(OTHER));
    r.emit(CONFIG_CHANGE_CHANNEL, "không phải JSON");
    r.emit("rollout_intent", noticeFor(HELD));
    expect(r.wakes()).toBe(2);
    await r.stop();
  });

  it("holds ném cũng không thoát ra khỏi listener của pg", async () => {
    const r = await listening(() => {
      throw new Error("hỏng");
    });
    expect(() => {
      r.emit(CONFIG_CHANGE_CHANNEL, noticeFor(HELD));
    }).not.toThrow();
    await r.stop();
  });
});
