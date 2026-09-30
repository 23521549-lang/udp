import { useQuery } from "@tanstack/react-query";
import { CircleAlert } from "lucide-react";
import { useMemo, type ReactNode } from "react";
import { Field } from "../../components/Field";
import { Icon } from "../../components/Icon";
import { useMessages } from "../../i18n";
import { qk } from "../../lib/query-keys";
import { architectureApi } from "../architecture/architecture-api";
import { useProjectContext } from "../project/ProjectLayout";
import { rolloutMessages } from "./rollout.messages";

/** Các mảnh dùng chung của hai hộp tạo rollout (FLAG_LEVEL, SERVICE_LEVEL — Plan #51) */

/** Tên workload hợp lệ: cùng luật tên với Kubernetes (Service 1 kiểm lại) */
export const WORKLOAD_NAME =
  /^[a-z0-9]([-a-z0-9]*[a-z0-9])?(\.[a-z0-9]([-a-z0-9]*[a-z0-9])?)*$/;

/** [Plan #58 UX-39] Ô số với nhãn, gợi ý và lỗi gắn vào ô (`Field`) */
export function NumberField({
  id,
  label,
  hint,
  error,
  value,
  onChange,
  min,
  max,
  step = 1,
}: {
  id: string;
  label: string;
  hint?: string;
  error?: string | undefined;
  value: number;
  onChange: (v: number) => void;
  min?: number;
  max?: number;
  step?: number;
}) {
  return (
    <Field id={id} label={label} hint={hint} error={error}>
      {(p) => (
        <input
          {...p}
          className="inp num"
          type="number"
          value={value}
          min={min}
          max={max}
          step={step}
          onChange={(e) => onChange(Number(e.target.value))}
        />
      )}
    </Field>
  );
}

/**
 * [Plan #58 UX-29] Workload đã deploy ở environment đang chọn — lấy từ sơ đồ Kiến trúc (lịch sử deploy), dùng làm
 * gợi ý cho ô workload. Chưa tải được thì danh sách rỗng: ô vẫn gõ tay được như trước.
 */
export function useKnownWorkloads(projectId: string, envId: string): string[] {
  const arch = useQuery({
    queryKey: qk.architecture(projectId),
    queryFn: () => architectureApi.get(projectId),
    staleTime: 60_000,
  });
  return useMemo(
    () =>
      arch.data?.architecture.environments
        .find((e) => e.id === envId)
        ?.workloads.map((w) => w.name) ?? [],
    [arch.data, envId],
  );
}

/**
 * Ô workload của cả hai hộp: chọn trong danh sách workload đã biết (`datalist`) hoặc gõ tên, kèm nút kiểm tra metric.
 * Lỗi tên, lỗi kiểm tra và lỗi của máy chủ nằm dưới ô, gắn vào ô.
 */
export function WorkloadField({
  id,
  value,
  onChange,
  checking,
  onCheck,
  hint,
  error,
}: {
  id: string;
  value: string;
  onChange: (name: string) => void;
  checking: boolean;
  onCheck: () => void;
  /** Kết quả kiểm tra metric; không có thì gợi ý là số workload đã biết */
  hint?: ReactNode;
  error?: string | undefined;
}) {
  const { form } = useMessages(rolloutMessages);
  const { project, env } = useProjectContext();
  const known = useKnownWorkloads(project.id, env.id);
  const listId = `${id}-known`;
  const valid = WORKLOAD_NAME.test(value);
  return (
    <Field
      id={id}
      label={form.workload}
      hint={
        hint ??
        (known.length > 0
          ? form.workloadKnown(known.length, env.name)
          : undefined)
      }
      error={value !== "" && !valid ? form.workloadInvalid : error}
    >
      {(p) => (
        <div className="line">
          <input
            {...p}
            className="inp mono"
            list={known.length > 0 ? listId : undefined}
            placeholder={form.workloadPlaceholder}
            autoComplete="off"
            spellCheck={false}
            value={value}
            onChange={(e) => onChange(e.target.value.trim())}
          />
          {known.length > 0 && (
            <datalist id={listId}>
              {known.map((name) => (
                <option key={name} value={name} />
              ))}
            </datalist>
          )}
          <button
            type="button"
            className="btn"
            disabled={!valid || checking}
            onClick={onCheck}
          >
            {checking ? form.checking : form.checkMetrics}
          </button>
        </div>
      )}
    </Field>
  );
}

/**
 * [Plan #58 UX-39] Lỗi theo ô của máy chủ mà form không có ô để đặt (ô đang ẩn, trường lồng lạ) — hiện ở câu chung
 * cuối hộp để không lỗi nào bị nuốt.
 */
export function unplacedErrors(
  fields: Record<string, string>,
  placed: readonly string[],
): string[] {
  return Object.entries(fields)
    .filter(([key]) => !placed.includes(key))
    .map(([, message]) => message);
}

/**
 * Màn 422 của §10.13: workload chưa xuất metric (probe pha 1). Nói đúng đoạn mã cần thêm
 * theo ngôn ngữ của project, có nút kiểm tra lại, và KHÔNG cho tạo rollout chạy mù.
 */
export function MetricsSetupGuide({
  runtime,
  workload,
  onRetry,
}: {
  runtime: string;
  workload: string;
  onRetry: () => void;
}) {
  const m = useMessages(rolloutMessages).form.metricsGuide;
  // [Plan #47] Provider Python có middleware ASGI (và WSGI: UDPMetricsWSGIMiddleware), §6.8
  const python = runtime.toLowerCase().startsWith("python");
  const code = python
    ? "from udp_openfeature.metrics import UDPMetricsMiddleware\n\napp.add_middleware(UDPMetricsMiddleware)"
    : 'import { udpMetricsMiddleware } from "@udp/openfeature-provider/metrics";\n\napp.use(udpMetricsMiddleware());';
  return (
    <div className="alert amber" role="alert">
      <Icon of={CircleAlert} />
      <div>
        <b>{m.title(workload)}</b>
        <p className="c2" style={{ margin: "4px 0 8px" }}>
          {m.body}
        </p>
        <div className="code">
          <pre>{code}</pre>
        </div>
        <button
          type="button"
          className="btn"
          style={{ marginTop: 8 }}
          onClick={onRetry}
        >
          {m.recheck}
        </button>
      </div>
    </div>
  );
}
