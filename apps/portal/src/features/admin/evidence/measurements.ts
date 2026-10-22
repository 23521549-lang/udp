import {
  isChartedMeasurement,
  MEASUREMENT_DATA_SCHEMAS,
  measurementEnvelopeSchema,
  measurementFileName,
  type MeasurementEnvelope,
} from "@udp/shared-types/measurements";

/**
 * [Plan #56 QĐ-2] Tệp kết quả đo đã đọc: số chính thức của mỗi phép đo là tệp MỚI NHẤT theo tên
 * (`<EXP>-<YYYYMMDD-HHmm>.json`) — quy ước của `docs/measurements/README.md`; các lần đo bị loại đều cũ hơn.
 */
export interface LoadedMeasurement {
  experiment: string;
  file: string;
  /** Nguyên văn — nút "Tải tệp thô" trả đúng tệp đã commit */
  text: string;
  /** Tên các lần đo cũ hơn của cùng phép đo, mới trước */
  earlier: string[];
  /** Vỏ (truy nguồn) — `null` khi tệp không đọc được */
  envelope: MeasurementEnvelope | null;
  /** `data` đã qua schema của phép đo; phép đo chưa có schema riêng ⇒ `undefined` */
  data: unknown;
  /** Câu mô tả chỗ sai khi tệp không qua schema — trang hiện thẻ lỗi thay vì trắng */
  problem: string | null;
}

function load(file: string, text: string): Omit<LoadedMeasurement, "earlier"> {
  const name = measurementFileName(file);
  const experiment = name?.experiment ?? file;
  const failed = (problem: string) => ({
    experiment,
    file,
    text,
    envelope: null,
    data: undefined,
    problem,
  });
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (e) {
    return failed(e instanceof Error ? e.message : String(e));
  }
  const envelope = measurementEnvelopeSchema.safeParse(json);
  if (!envelope.success) {
    return failed(
      envelope.error.issues
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("; "),
    );
  }
  if (!isChartedMeasurement(experiment)) {
    return {
      experiment,
      file,
      text,
      envelope: envelope.data,
      data: undefined,
      problem: null,
    };
  }
  const data = MEASUREMENT_DATA_SCHEMAS[experiment].safeParse(
    envelope.data.data,
  );
  return data.success
    ? {
        experiment,
        file,
        text,
        envelope: envelope.data,
        data: data.data,
        problem: null,
      }
    : {
        ...failed(
          data.error.issues
            .map((i) => `data.${i.path.join(".")}: ${i.message}`)
            .join("; "),
        ),
        envelope: envelope.data,
      };
}

/** Mỗi phép đo một tệp chính thức (mới nhất), từ nội dung tệp theo đường dẫn */
export function measurementsFrom(
  files: Readonly<Record<string, string>>,
): Map<string, LoadedMeasurement> {
  const byExperiment = new Map<string, { file: string; text: string }[]>();
  for (const [path, text] of Object.entries(files)) {
    const file = path.split("/").pop() ?? path;
    const experiment = measurementFileName(file)?.experiment ?? file;
    const list = byExperiment.get(experiment) ?? [];
    list.push({ file, text });
    byExperiment.set(experiment, list);
  }
  const out = new Map<string, LoadedMeasurement>();
  for (const [experiment, list] of byExperiment) {
    const sorted = [...list].sort((a, b) => b.file.localeCompare(a.file));
    const [latest, ...older] = sorted;
    if (latest === undefined) continue;
    out.set(experiment, {
      ...load(latest.file, latest.text),
      earlier: older.map((f) => f.file),
    });
  }
  return out;
}

/** Nạp chunk tệp thô (chỉ khi mở trang) rồi đọc */
export async function loadMeasurements(): Promise<
  Map<string, LoadedMeasurement>
> {
  const { MEASUREMENT_FILES } = await import("./measurement-files");
  return measurementsFrom(MEASUREMENT_FILES);
}
