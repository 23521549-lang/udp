import {
  configHashOf,
  type SdkStreamChange,
  type Snapshot,
  type SnapshotFlag,
} from "@udp/flag-evaluator";
import type { SseItem } from "../../src/sse.js";
import type {
  ConfigResult,
  StreamOpen,
  Transport,
} from "../../src/transport.js";

/**
 * Transport giả điều khiển được — test đơn vị tất định cho vòng đồng bộ: mỗi lời
 * gọi `/sdk/config` lấy phản hồi kế tiếp trong hàng đợi, mỗi lần mở stream lấy
 * một `ScriptedStream` mà test đẩy sự kiện vào.
 */

export class ScriptedStream {
  private readonly queue: (SseItem | "end" | "fail")[] = [];
  private wake: (() => void) | undefined;

  push(item: SseItem): void {
    this.queue.push(item);
    this.wake?.();
  }
  event(event: string, data: unknown): void {
    this.push({
      kind: "event",
      event,
      data: JSON.stringify(data),
      id: undefined,
    });
  }
  end(): void {
    this.queue.push("end");
    this.wake?.();
  }
  fail(): void {
    this.queue.push("fail");
    this.wake?.();
  }

  async *items(signal: AbortSignal): AsyncGenerator<SseItem> {
    for (;;) {
      if (signal.aborted) throw new Error("aborted");
      const next = this.queue.shift();
      if (next === "end") return;
      if (next === "fail") throw new Error("stream hỏng");
      if (next !== undefined) {
        yield next;
        continue;
      }
      await new Promise<void>((resolve) => {
        this.wake = resolve;
        signal.addEventListener("abort", () => resolve(), { once: true });
      });
      this.wake = undefined;
    }
  }
}

export class FakeTransport implements Transport {
  readonly configCalls: (string | undefined)[] = [];
  readonly streamCalls: (number | undefined)[] = [];
  /** `"hang"`: server nhận kết nối rồi im — chỉ tín hiệu huỷ/quá hạn kết thúc nó */
  readonly configs: (ConfigResult | "hang")[] = [];
  readonly streams: (ScriptedStream | Exclude<StreamOpen, { kind: "open" }>)[] =
    [];
  /** Phản hồi khi hàng đợi `/sdk/config` rỗng */
  defaultConfig: ConfigResult = {
    kind: "unavailable",
    retryAfterMs: undefined,
  };

  getConfig(
    ifNoneMatch: string | undefined,
    signal: AbortSignal,
  ): Promise<ConfigResult> {
    this.configCalls.push(ifNoneMatch);
    const next = this.configs.shift() ?? this.defaultConfig;
    if (next !== "hang") return Promise.resolve(next);
    return new Promise((resolve) => {
      signal.addEventListener(
        "abort",
        () => resolve({ kind: "unavailable", retryAfterMs: undefined }),
        { once: true },
      );
    });
  }

  openStream(
    since: number | undefined,
    signal: AbortSignal,
  ): Promise<StreamOpen> {
    this.streamCalls.push(since);
    const next = this.streams.shift();
    if (next === undefined) {
      return Promise.resolve({ kind: "unavailable", retryAfterMs: undefined });
    }
    if (next instanceof ScriptedStream) {
      return Promise.resolve({ kind: "open", items: next.items(signal) });
    }
    return Promise.resolve(next);
  }
}

export const flag = (
  key: string,
  over: Partial<SnapshotFlag> = {},
): SnapshotFlag => ({
  key,
  type: "BOOLEAN",
  isEnabled: true,
  stickinessAttribute: "targetingKey",
  variants: { on: true, off: false },
  defaultVariantKey: "on",
  rules: [],
  ...over,
});

/** Body `/sdk/config` (hoặc data của event `snapshot`) có hash đúng */
export function configBody(
  configVersion: number,
  flags: Snapshot["flags"],
  trackedFlags: string[] = [],
) {
  const snapshot: Snapshot = { flags, segments: [], trackedFlags };
  return {
    configVersion,
    configHash: configHashOf(snapshot),
    environment: "dev",
    trackedFlags,
    flags,
    segments: [],
  };
}

/** Data của event `flag_changed` từ `from` sang snapshot `after` */
export function deltaBody(
  fromVersion: number,
  toVersion: number,
  after: Snapshot,
  changes: SdkStreamChange[],
  configHash: string = configHashOf(after),
) {
  return { fromVersion, toVersion, configHash, changes };
}

export async function waitFor(
  condition: () => boolean,
  timeoutMs = 3_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("hết giờ chờ điều kiện");
    await new Promise((r) => setTimeout(r, 5));
  }
}
