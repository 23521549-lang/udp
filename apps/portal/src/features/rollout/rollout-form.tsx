import { CircleAlert } from "lucide-react";
import { Icon } from "../../components/Icon";

/** Hai mảnh dùng chung của hai hộp tạo rollout (FLAG_LEVEL, SERVICE_LEVEL — Plan #51) */

export function NumberField({
  id,
  label,
  hint,
  value,
  onChange,
  min,
  max,
  step = 1,
}: {
  id: string;
  label: string;
  hint?: string;
  value: number;
  onChange: (v: number) => void;
  min?: number;
  max?: number;
  step?: number;
}) {
  return (
    <div className="f">
      <label htmlFor={id}>{label}</label>
      <input
        id={id}
        className="inp num"
        type="number"
        value={value}
        min={min}
        max={max}
        step={step}
        onChange={(e) => onChange(Number(e.target.value))}
      />
      {hint !== undefined && <span className="help">{hint}</span>}
    </div>
  );
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
  // [Plan #47] Provider Python có middleware ASGI (và WSGI: UDPMetricsWSGIMiddleware), §6.8
  const python = runtime.toLowerCase().startsWith("python");
  const code = python
    ? "from udp_openfeature.metrics import UDPMetricsMiddleware\n\napp.add_middleware(UDPMetricsMiddleware)"
    : 'import { udpMetricsMiddleware } from "@udp/openfeature-provider/metrics";\n\napp.use(udpMetricsMiddleware());';
  return (
    <div className="alert amber" role="alert">
      <Icon of={CircleAlert} />
      <div>
        <b>Workload {workload} chưa xuất metric HTTP</b>
        <p className="c2" style={{ margin: "4px 0 8px" }}>
          Rollout cần so tỉ lệ lỗi giữa hai nhánh (flag hay phiên bản). Thêm
          middleware sau vào ứng dụng, deploy lại, rồi kiểm tra lại.
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
          Kiểm tra lại
        </button>
      </div>
    </div>
  );
}
