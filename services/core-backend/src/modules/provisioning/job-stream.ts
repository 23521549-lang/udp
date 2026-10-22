/**
 * Vòng SSE của `GET /projects/:id/jobs/:jobId/stream` (Plan #28 QĐ-6) — THUẦN trên cổng.
 *
 * Tiến độ đọc từ DATABASE mỗi `pollMs`: worker và request có thể ở hai tiến trình, nên
 * không có bộ nhớ chung nào để đẩy sự kiện. Gửi `snapshot` khi ảnh chụp khác lần trước,
 * `heartbeat` khi đã `heartbeatMs` không gửi gì (proxy không cắt kết nối im lặng), và tự
 * đóng ở trạng thái kết thúc. Portal chỉ `invalidateQueries` khi nhận sự kiện (§10.14).
 */

export const JOB_STREAM_TIMING = { pollMs: 1_000, heartbeatMs: 15_000 };

export interface JobStreamPorts {
  /** Ảnh chụp hiện tại đã tuần tự hoá; `null` = job không còn */
  snapshot(): Promise<{ json: string; terminal: boolean } | null>;
  send(event: "snapshot" | "heartbeat", data: string): void;
  /** Client đã đóng kết nối */
  closed(): boolean;
  sleep(ms: number): Promise<void>;
  now(): number;
}

export async function streamJob(
  ports: JobStreamPorts,
  timing: { pollMs: number; heartbeatMs: number } = JOB_STREAM_TIMING,
): Promise<void> {
  let last: string | null = null;
  let lastSentAt = ports.now();
  while (!ports.closed()) {
    const snap = await ports.snapshot();
    if (snap === null) return;
    if (snap.json !== last) {
      ports.send("snapshot", snap.json);
      last = snap.json;
      lastSentAt = ports.now();
    } else if (ports.now() - lastSentAt >= timing.heartbeatMs) {
      ports.send("heartbeat", "{}");
      lastSentAt = ports.now();
    }
    if (snap.terminal) return;
    await ports.sleep(timing.pollMs);
  }
}
