import { percentile, round } from "./stats.js";

/**
 * **E9** (§14.1) [Plan #50] — tài nguyên tiêu thụ của UDP, đọc từ Summary API của kubelet
 * (`/api/v1/nodes/<node>/proxy/stats/summary`): đúng nguồn mà metrics-server đọc, nên phép đo không thêm
 * thành phần nào vào cụm. Phần thuần ở đây để test được; `scripts/e9.ts` gọi kubectl và dựng tải.
 *
 * CPU = Δ`usageCoreNanoSeconds` / Δ`cpu.time` — bộ đếm tích luỹ và mốc thời gian của CHÍNH lần cAdvisor lấy
 * mẫu, không phải lúc harness hỏi. RAM = `workingSetBytes`: số `kubectl top` hiện và số OOM-killer xét.
 */

/** Tên hiển thị của mẫu cấp node — gộp chung vào bảng cùng container */
export const NODE_SCOPE = "(node)";

export interface ContainerSample {
  namespace: string;
  pod: string;
  container: string;
  /** `cpu.time` của cAdvisor, epoch ms */
  cpuAtMs: number;
  cpuCoreNanoSeconds: number;
  workingSetBytes: number;
}

interface StatBlock {
  cpu?: { time?: string; usageCoreNanoSeconds?: number };
  memory?: { workingSetBytes?: number };
}

interface Summary {
  node?: { nodeName?: string } & StatBlock;
  pods?: {
    podRef?: { name?: string; namespace?: string };
    containers?: ({ name?: string } & StatBlock)[];
  }[];
}

function sampleOf(
  namespace: string,
  pod: string,
  container: string,
  block: StatBlock,
): ContainerSample | null {
  const at = Date.parse(block.cpu?.time ?? "");
  const cpu = block.cpu?.usageCoreNanoSeconds;
  const memory = block.memory?.workingSetBytes;
  // cAdvisor chưa kịp lấy mẫu container vừa khởi động ⇒ thiếu trường: bỏ, không đoán
  if (Number.isNaN(at) || cpu === undefined || memory === undefined) {
    return null;
  }
  return {
    namespace,
    pod,
    container,
    cpuAtMs: at,
    cpuCoreNanoSeconds: cpu,
    workingSetBytes: memory,
  };
}

/** Mẫu của node và của mọi container thuộc namespace mà `keep` giữ */
export function parseSummary(
  raw: string,
  keep: (namespace: string) => boolean,
): ContainerSample[] {
  const summary = JSON.parse(raw) as Summary;
  const out: ContainerSample[] = [];
  if (summary.node !== undefined) {
    const node = sampleOf(
      NODE_SCOPE,
      summary.node.nodeName ?? "",
      "node",
      summary.node,
    );
    if (node !== null) out.push(node);
  }
  for (const pod of summary.pods ?? []) {
    const namespace = pod.podRef?.namespace ?? "";
    if (!keep(namespace)) continue;
    for (const c of pod.containers ?? []) {
      const sample = sampleOf(
        namespace,
        pod.podRef?.name ?? "",
        c.name ?? "",
        c,
      );
      if (sample !== null) out.push(sample);
    }
  }
  return out;
}

export interface Usage {
  namespace: string;
  container: string;
  /** Trung bình cả pha, từ hai đầu của bộ đếm tích luỹ */
  cpuMillicoresMean: number;
  /** Cực đại theo khoảng giữa hai lần cAdvisor lấy mẫu */
  cpuMillicoresMax: number;
  memoryMiBP50: number;
  memoryMiBMax: number;
  /** Số mẫu RAM khác mốc thời gian của cAdvisor */
  samples: number;
}

const MIB = 1024 * 1024;
const millicores = (deltaNs: number, deltaMs: number): number =>
  deltaNs / (deltaMs * 1000);

/**
 * Gộp các lượt hỏi của MỘT pha theo (namespace, container). Mẫu trùng mốc `cpu.time` (harness hỏi nhanh hơn
 * nhịp của cAdvisor) chỉ tính một lần. Container khởi động lại trong pha ⇒ bộ đếm tụt: khoảng đó bị bỏ khỏi
 * cực đại và trung bình thành `NaN` (JSON `null`, không đo được) — số của một container crash giữa phép đo
 * không được trình bày như số rỗi. Pod bị thay (tên mới) ⇒ chỉ lấy pod có nhiều mẫu nhất.
 */
export function usageOf(ticks: readonly ContainerSample[][]): Usage[] {
  const byPod = new Map<string, ContainerSample[]>();
  for (const sample of ticks.flat()) {
    const key = `${sample.namespace}\0${sample.pod}\0${sample.container}`;
    const list = byPod.get(key) ?? [];
    if (!list.some((s) => s.cpuAtMs === sample.cpuAtMs)) list.push(sample);
    byPod.set(key, list);
  }

  const best = new Map<string, ContainerSample[]>();
  for (const list of byPod.values()) {
    const first = list[0];
    if (first === undefined) continue;
    const key = `${first.namespace}\0${first.container}`;
    if ((best.get(key)?.length ?? 0) < list.length) best.set(key, list);
  }

  return [...best.values()]
    .map((list): Usage => {
      const sorted = [...list].sort((a, b) => a.cpuAtMs - b.cpuAtMs);
      const first = sorted[0] as ContainerSample;
      const last = sorted[sorted.length - 1] as ContainerSample;
      const rates: number[] = [];
      for (let i = 1; i < sorted.length; i++) {
        const a = sorted[i - 1] as ContainerSample;
        const b = sorted[i] as ContainerSample;
        const dNs = b.cpuCoreNanoSeconds - a.cpuCoreNanoSeconds;
        if (dNs >= 0) rates.push(millicores(dNs, b.cpuAtMs - a.cpuAtMs));
      }
      const spanMs = last.cpuAtMs - first.cpuAtMs;
      const spanNs = last.cpuCoreNanoSeconds - first.cpuCoreNanoSeconds;
      const memory = sorted.map((s) => s.workingSetBytes).sort((a, b) => a - b);
      return {
        namespace: first.namespace,
        container: first.container,
        cpuMillicoresMean:
          spanMs > 0 && spanNs >= 0
            ? round(millicores(spanNs, spanMs), 1)
            : NaN,
        cpuMillicoresMax: rates.length > 0 ? round(Math.max(...rates), 1) : NaN,
        memoryMiBP50: round(percentile(memory, 0.5) / MIB, 1),
        memoryMiBMax: round((memory[memory.length - 1] ?? NaN) / MIB, 1),
        samples: sorted.length,
      };
    })
    .sort(
      (a, b) =>
        a.namespace.localeCompare(b.namespace) ||
        a.container.localeCompare(b.container),
    );
}

/**
 * RAM mỗi stream SSE của một container: chênh `workingSet` trung vị giữa pha tải và pha rỗi, chia số stream,
 * KiB. `null` khi thiếu một trong hai pha.
 */
export function perStreamKiB(
  idle: readonly Usage[],
  loaded: readonly Usage[],
  container: string,
  streams: number,
): number | null {
  const before = idle.find((u) => u.container === container);
  const after = loaded.find((u) => u.container === container);
  if (before === undefined || after === undefined || streams <= 0) return null;
  return round(
    ((after.memoryMiBP50 - before.memoryMiBP50) * 1024) / streams,
    1,
  );
}

/** `Retry-After` dạng số giây (Service 2 chỉ gửi dạng này); thiếu/hỏng ⇒ `fallbackSeconds` */
export function retryAfterMs(
  header: string | undefined,
  fallbackSeconds: number,
): number {
  const seconds =
    header === undefined || header.trim() === "" ? NaN : Number(header);
  return (
    (Number.isFinite(seconds) && seconds >= 0 ? seconds : fallbackSeconds) *
    1000
  );
}
