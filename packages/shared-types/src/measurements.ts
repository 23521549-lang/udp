import { z } from "zod";

/**
 * [v4.11, Plan #56] Hình của tệp kết quả đo `docs/measurements/raw/<EXP>-<YYYYMMDD-HHmm>.json` (§14).
 *
 * Người ghi là harness (`@udp/experiments`, `writeResult`); người đọc là trang "Bằng chứng" của Bảng điều khiển nền
 * tảng. Schema nằm ở đây — không ở Portal — để cả hai phía cùng nhìn một hợp đồng, và để một phép kiểm parse MỌI tệp
 * thô đang có trong repo (`tests/measurements.test.ts`): harness đổi hình mà quên schema là đỏ ngay, không phải một
 * thẻ lỗi phát hiện lúc bảo vệ luận văn.
 *
 * Không `.strict()`, có chủ đích: tệp thô là bằng chứng đã commit và không bao giờ viết lại, nên harness được THÊM
 * trường về sau mà tệp cũ vẫn đọc được. Schema chỉ chốt những trường trang đọc.
 */

/** Vỏ chung — truy nguồn: commit, cây có thay đổi chưa commit, máy đo, hình học mạng */
export const measurementEnvironmentSchema = z.object({
  commit: z.string().min(7),
  sourceDirty: z.boolean(),
  sourceDiffSha256: z.string(),
  node: z.string(),
  os: z.string(),
  cpu: z.string(),
  cpuCount: z.number().int().positive(),
  memoryGiB: z.number().nonnegative(),
  freeMemoryGiB: z.number().nonnegative(),
  geometry: z.string(),
  note: z.string().optional(),
});

const percentiles = z.object({
  p50: z.number(),
  p90: z.number(),
  p99: z.number(),
  max: z.number(),
});

/** E1 — effort mở rộng adapter, đo từ git */
export const e1DataSchema = z.object({
  tag: z.string(),
  tagCommit: z.string(),
  head: z.string(),
  interfaceBreaks: z.object({ count: z.number().int().nonnegative() }),
  contractRelaxations: z.number().int().nonnegative(),
  toolsAtHead: z.number().int().nonnegative(),
  toolsAddedAfterTag: z.number().int().nonnegative(),
  batches: z.array(
    z.object({
      commit: z.string(),
      subject: z.string(),
      tools: z.array(z.string()),
      files: z.number().int().nonnegative(),
      byKind: z.record(z.number().int().nonnegative()),
      outsideAdapters: z.array(z.string()),
    }),
  ),
  outsideAdaptersTotal: z.number().int().nonnegative(),
  outsideAdaptersPerTool: z.number().nonnegative(),
});

/** E3 — độ trễ đánh giá flag cục bộ (µs), và OFREP làm đối chứng remote (ms) */
export const e3DataSchema = z.object({
  local: z.array(
    z.object({
      flags: z.number().int().positive(),
      rulesPerFlag: z.number().int().positive(),
      tracked: z.number().int().nonnegative(),
      coreUs: percentiles,
      sdkUs: percentiles,
      sdkThroughputPerSecond: z.number().nonnegative(),
    }),
  ),
  remote: z.object({
    samples: z.number().int().positive(),
    rateRps: z.number().positive(),
    latencyMs: percentiles,
  }),
});

/** E4 — độ trễ lan truyền thay đổi flag, theo chế độ change feed */
export const e4DataSchema = z.object({
  cells: z.array(
    z.object({
      flags: z.number().int().positive(),
      mode: z.enum(["snapshot", "delta"]),
      notify: z.boolean(),
      runs: z.number().int().positive(),
      timeouts: z.number().int().nonnegative(),
      latencyMs: percentiles,
      queriesPerChange: z.object({ median: z.number() }),
      serverBytesPerChange: z.object({ median: z.number() }),
      sdkBytesPerChange: z.object({ median: z.number() }),
    }),
  ),
});

/** E7 — chất lượng phân phối của consistent hashing (χ² so với giá trị tới hạn) */
export const e7DataSchema = z.object({
  alpha: z.number().positive(),
  scenarios: z.array(
    z.object({
      name: z.string(),
      n: z.number().int().positive(),
      df: z.number().int().positive(),
      critical: z.number().positive(),
      chi2: z.number().nonnegative(),
      pass: z.boolean(),
      variants: z.array(
        z.object({
          key: z.string(),
          expectedShare: z.number().min(0).max(1),
          observedShare: z.number().min(0).max(1),
        }),
      ),
    }),
  ),
});

/** E8 — mutation testing của capability validator, đối chiếu oracle */
export const e8DataSchema = z.object({
  mutants: z.number().int().nonnegative(),
  killedByDifferential: z.number().int().nonnegative(),
  killedBySuite: z.number().int().nonnegative(),
  survivors: z.array(z.string()),
  oracleCodes: z.number().int().nonnegative(),
  results: z.array(
    z.object({
      id: z.string(),
      what: z.string(),
      killedByDifferential: z.boolean(),
      killedBySuite: z.boolean(),
    }),
  ),
});

const seriesCount = z.object({
  bucket: z.number().int().nonnegative(),
  total: z.number().int().nonnegative(),
});

/** E14 — chi phí cardinality của nhãn `ff`: số series dự đoán so với đo */
export const e14DataSchema = z.object({
  method: z.object({ formula: z.string() }),
  cells: z.array(
    z.object({
      T: z.number().int().nonnegative(),
      V: z.number().int().positive(),
      predicted: seriesCount,
      complete: z.object({
        series: seriesCount,
        expositionBytes: z.number().int().nonnegative(),
      }),
      completeMatchesFormula: z.boolean(),
      realistic: z.object({ series: seriesCount }),
    }),
  ),
});

/** I34 — Service 2 mất kết nối database: không đánh giá sai, và hội tụ lại sau khi nối */
export const i34DataSchema = z.object({
  pass: z.boolean(),
  phases: z.array(
    z.object({
      phase: z.string(),
      pass: z.boolean(),
      outageSeconds: z.number().nonnegative(),
      evaluationsDuringOutage: z.number().int().nonnegative(),
      wrongOrErrorDuringOutage: z.number().int().nonnegative(),
      convergedAfterRestoreSeconds: z.number().nonnegative(),
      convergeLimitSeconds: z.number().positive(),
    }),
  ),
});

const latencySamples = z.object({
  p50Ms: z.number(),
  p95Ms: z.number(),
  p99Ms: z.number(),
  maxMs: z.number(),
  samplesMs: z.array(z.number()),
});

/** Plan #41 — thời gian trả một trang danh sách flag (200 flag × 3 env), ngưỡng 500 ms */
export const flagListDataSchema = z.object({
  flags: z.number().int().positive(),
  environments: z.number().int().positive(),
  runs: z.number().int().positive(),
  thresholdMs: z.number().positive(),
  page: latencySamples,
  count: latencySamples,
  fullList: latencySamples,
});

/** Schema `data` theo tiền tố tên tệp — tiền tố nào không có ở đây là tệp chưa có biểu đồ riêng */
export const MEASUREMENT_DATA_SCHEMAS = {
  E1: e1DataSchema,
  E3: e3DataSchema,
  E4: e4DataSchema,
  E7: e7DataSchema,
  E8: e8DataSchema,
  E14: e14DataSchema,
  I34: i34DataSchema,
  "portal-pagination": flagListDataSchema,
} as const;

export type ChartedMeasurement = keyof typeof MEASUREMENT_DATA_SCHEMAS;

/** Tệp của phép đo này có schema `data` riêng (và một biểu đồ riêng trên trang Bằng chứng) */
export const isChartedMeasurement = (
  experiment: string,
): experiment is ChartedMeasurement =>
  Object.hasOwn(MEASUREMENT_DATA_SCHEMAS, experiment);

/** Vỏ của MỌI tệp thô — `data` để `unknown`, parse riêng bằng schema của phép đo */
export const measurementEnvelopeSchema = z.object({
  experiment: z.string().min(1),
  at: z.string().datetime({ offset: true }),
  environment: measurementEnvironmentSchema,
  data: z.unknown(),
});

export type MeasurementEnvelope = z.infer<typeof measurementEnvelopeSchema>;
export type MeasurementEnvironment = z.infer<
  typeof measurementEnvironmentSchema
>;
export type E1Data = z.infer<typeof e1DataSchema>;
export type E3Data = z.infer<typeof e3DataSchema>;
export type E4Data = z.infer<typeof e4DataSchema>;
export type E7Data = z.infer<typeof e7DataSchema>;
export type E8Data = z.infer<typeof e8DataSchema>;
export type E14Data = z.infer<typeof e14DataSchema>;
export type I34Data = z.infer<typeof i34DataSchema>;
export type FlagListData = z.infer<typeof flagListDataSchema>;

/** `E3-20260922-1906.json` ⇒ `{ experiment: "E3", stamp: "20260922-1906" }`; tên sai quy ước ⇒ `null` */
export function measurementFileName(
  file: string,
): { experiment: string; stamp: string } | null {
  const m = /^(.+)-(\d{8}-\d{4})\.json$/.exec(file);
  return m?.[1] === undefined || m[2] === undefined
    ? null
    : { experiment: m[1], stamp: m[2] };
}
