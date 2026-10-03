import { writeFileSync } from "node:fs";
import { parseArgs } from "node:util";

/**
 * Tải cố định VÒNG MỞ cho sample-app (E5, I34) [v4.8] — thay k6 (không cài trên
 * máy đo). Vòng mở: request thứ i bắn đúng lúc `t0 + i/rps` bất kể các request
 * trước đã trả lời chưa. Vòng đóng (chờ trả lời rồi mới bắn tiếp) làm rps TỤT khi
 * bơm độ trễ — đúng lúc E5 cần tải giữ nguyên để MTTD của các nhánh so được.
 *
 *   pnpm --filter @udp/sample-app load --base http://127.0.0.1:3010,http://127.0.0.1:3011 \
 *     --rps 50 --duration 600 --users 1000 [--out ket-qua.json]
 *
 * `--base` nhận danh sách phân cách dấu phẩy: request thứ i tới base thứ i mod n
 * (tất định) — ô "lỗi ở một phần pod" của E5 chia đều tải cho hai instance.
 *
 * Trộn cố định: 70% `POST /api/checkout` (user ngẫu nhiên trong tập `users`),
 * 20% `GET /api/products`, 10% `GET /api/products/:id`.
 */

const { values } = parseArgs({
  options: {
    base: { type: "string", default: "http://127.0.0.1:3010" },
    rps: { type: "string", default: "50" },
    duration: { type: "string", default: "60" },
    users: { type: "string", default: "1000" },
    out: { type: "string" },
  },
});

const bases = values.base
  .split(",")
  .map((b) => b.trim())
  .filter((b) => b.length > 0);
if (bases.length === 0) throw new Error("--base rỗng");
const rps = Number(values.rps);
const durationMs = Number(values.duration) * 1000;
const users = Number(values.users);
if (!(rps > 0) || !(durationMs > 0) || !(users > 0)) {
  throw new Error("--rps, --duration, --users phải là số dương");
}

const byStatus = new Map<string, number>();
const latencies: number[] = [];
let sent = 0;
let inFlight = 0;
let maxInFlight = 0;

function pick(i: number): { path: string; init: RequestInit } {
  const r = (i * 0.618_033_988_75) % 1; // phân bố đều, tất định theo i
  if (r < 0.7) {
    const user = `user-${String(Math.floor(Math.random() * users))}`;
    return {
      path: "/api/checkout",
      init: { method: "POST", headers: { "x-user-id": user } },
    };
  }
  if (r < 0.9) return { path: "/api/products", init: { method: "GET" } };
  return {
    path: `/api/products/p-${String(1 + (i % 10))}`,
    init: { method: "GET" },
  };
}

async function fire(i: number): Promise<void> {
  const { path, init } = pick(i);
  const started = performance.now();
  inFlight += 1;
  maxInFlight = Math.max(maxInFlight, inFlight);
  let key: string;
  try {
    const res = await fetch(`${bases[i % bases.length] ?? ""}${path}`, {
      ...init,
      signal: AbortSignal.timeout(30_000),
    });
    await res.arrayBuffer();
    key = String(res.status);
  } catch {
    key = "network-error";
  } finally {
    inFlight -= 1;
  }
  latencies.push(performance.now() - started);
  byStatus.set(key, (byStatus.get(key) ?? 0) + 1);
}

const t0 = performance.now();
const pending: Promise<void>[] = [];
for (;;) {
  const due = t0 + (sent * 1000) / rps;
  if (due - t0 >= durationMs) break;
  const wait = due - performance.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  pending.push(fire(sent));
  sent += 1;
}
await Promise.all(pending);

latencies.sort((a, b) => a - b);
const pct = (p: number): number =>
  latencies[Math.max(0, Math.ceil(p * latencies.length) - 1)] ?? Number.NaN;
const summary = {
  bases,
  rps,
  durationSeconds: durationMs / 1000,
  sent,
  achievedRps: sent / ((performance.now() - t0) / 1000),
  maxInFlight,
  byStatus: Object.fromEntries(byStatus),
  latencyMs: { p50: pct(0.5), p90: pct(0.9), p99: pct(0.99) },
};
const text = `${JSON.stringify(summary, null, 2)}\n`;
if (values.out !== undefined) writeFileSync(values.out, text);
process.stdout.write(text);
