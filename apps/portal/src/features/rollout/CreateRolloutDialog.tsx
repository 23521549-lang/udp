import {
  keepPreviousData,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { canaryPairOf } from "@udp/shared-types/rollout";
import { CircleAlert } from "lucide-react";
import { useEffect, useState } from "react";
import { Dialog } from "../../components/Dialog";
import { Icon } from "../../components/Icon";
import { fieldErrorsOf, messageOf } from "../../lib/errors";
import { browserTimeZone } from "../../lib/format";
import { isApiError } from "../../lib/http";
import { qk } from "../../lib/query-keys";
import { flagApi } from "../flag/flag-api";
import { useProjectContext } from "../project/ProjectLayout";
import { rolloutApi, type CreateFlagRolloutInput } from "./rollout-api";

const DNS_1123 =
  /^[a-z0-9]([-a-z0-9]*[a-z0-9])?(\.[a-z0-9]([-a-z0-9]*[a-z0-9])?)*$/;

/**
 * Tạo rollout FLAG_LEVEL (§10.9 RolloutCreateSheet v4, đóng góp C1).
 *
 * Ba chốt trước khi cho gửi, mỗi cái chặn một cách chạy mù:
 * 1. Rule phải ramp được cho variant đó — kiểm bằng `canaryPairOf`, CÙNG hàm Service 1
 *    dùng để từ chối (một định nghĩa, không hai).
 * 2. Probe pha 1: workload phải có metric HTTP. `hasSeries = false` ⇒ hiện hướng dẫn cài
 *    middleware (MetricsSetupGuide) và KHÔNG cho tạo (§10.13).
 * 3. `Idempotency-Key` sinh LÚC BẤM GỬI: sinh lúc dựng form thì lần gửi thứ hai với nội
 *    dung khác bị 422 `IDEMPOTENCY_KEY_REUSED`.
 *
 * SERVICE_LEVEL và các chiến lược khác CANARY chưa có executor ở Service 3 (§7.2), nên
 * không có trong form — hiện chúng ra chỉ để nhận 422 là nói dối về khả năng hệ thống.
 */
export function CreateRolloutDialog({ onClose }: { onClose: () => void }) {
  const { project, env } = useProjectContext();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const tz = browserTimeZone();

  const [flagId, setFlagId] = useState("");
  const [ruleId, setRuleId] = useState("");
  const [variantId, setVariantId] = useState("");
  const [workloadName, setWorkloadName] = useState("");
  const [stepPercent, setStepPercent] = useState(10);
  const [stepInterval, setStepInterval] = useState(300);
  const [analysisInterval, setAnalysisInterval] = useState(30);
  const [warmUp, setWarmUp] = useState(100);
  const [errorRate, setErrorRate] = useState(5);
  const [latency, setLatency] = useState(500);
  const [minErrors, setMinErrors] = useState(5);
  const [breaches, setBreaches] = useState(2);

  // [Plan #41] Flag ACTIVE tìm ở máy chủ (FLAG_PAGE_SIZE hàng) — không tải trọn danh sách
  const [flagSearch, setFlagSearch] = useState("");
  const [flagTerm, setFlagTerm] = useState("");
  useEffect(() => {
    const t = setTimeout(() => {
      setFlagTerm(flagSearch.trim());
    }, 300);
    return () => clearTimeout(t);
  }, [flagSearch]);
  const flags = useQuery({
    queryKey: qk.flags(project.id, env.id, "none", {
      term: flagTerm,
      status: "ACTIVE",
    }),
    queryFn: () =>
      flagApi.page(project.id, env.id, tz, {
        search: flagTerm,
        status: "ACTIVE",
      }),
    placeholderData: keepPreviousData,
  });
  const flag = useQuery({
    queryKey: qk.flag(project.id, flagId, env.id),
    queryFn: () => flagApi.get(project.id, flagId),
    enabled: flagId !== "",
  });
  const rules = useQuery({
    queryKey: qk.flagRules(project.id, flagId, env.id),
    queryFn: () => flagApi.rules(project.id, flagId, env.id),
    enabled: flagId !== "",
  });

  const rule = rules.data?.rules.find((r) => r.id === ruleId);
  const pair =
    rule !== undefined && variantId !== ""
      ? canaryPairOf(rule.serve, variantId)
      : undefined;
  const envState = flag.data?.flag.envs.find(
    (e) => e.environment.id === env.id,
  );

  const probe = useMutation({
    mutationFn: () => rolloutApi.probe(project.id, env.id, workloadName),
  });
  const probed = probe.data?.probe;

  const create = useMutation({
    mutationFn: () => {
      if (envState === undefined)
        throw new Error("Flag chưa có cấu hình ở env này");
      const body: CreateFlagRolloutInput = {
        scope: "FLAG_LEVEL",
        envId: env.id,
        strategy: "CANARY",
        flagEnvConfigId: envState.configId,
        targetingRuleId: ruleId,
        targetVariantId: variantId,
        workloadName,
        stepPercent,
        stepIntervalSeconds: stepInterval,
        analysisIntervalSeconds: analysisInterval,
        warmUpRequests: warmUp,
        thresholds: {
          errorRate: errorRate / 100,
          latencyP99Ms: latency,
          minErrors,
          maxConsecutiveBreaches: breaches,
        },
      };
      return rolloutApi.create(project.id, body, crypto.randomUUID());
    },
    onSuccess: async ({ rollout }) => {
      await queryClient.invalidateQueries({
        queryKey: qk.rollouts(project.id, env.id),
      });
      onClose();
      await navigate({
        to: "/app/projects/$projectId/rollouts/$rolloutId",
        params: { projectId: project.id, rolloutId: rollout.id },
        search: { env: env.id },
      });
    },
  });
  const fields = fieldErrorsOf(create.error);

  const activeFlags = flags.data?.flags ?? [];
  const workloadOk = DNS_1123.test(workloadName);
  const flagOff = envState !== undefined && !envState.isEnabled;
  const ready =
    pair?.kind === "ok" &&
    workloadOk &&
    probed?.hasSeries === true &&
    !flagOff &&
    !create.isPending;

  const variantKey = (id: string) =>
    flag.data?.flag.variants.find((v) => v.id === id)?.key ?? id.slice(0, 8);

  return (
    <Dialog
      title={`Tạo rollout ở ${env.name}`}
      description="Canary theo flag: tăng dần tỉ lệ của một variant trong một rule phân phối, cùng một phiên bản mã."
      onClose={onClose}
      wide
      footer={
        <>
          <button type="button" className="btn" data-close onClick={onClose}>
            Huỷ
          </button>
          <button
            type="button"
            className="btn pri"
            disabled={!ready}
            onClick={() => create.mutate()}
          >
            {create.isPending ? "Đang tạo..." : "Tạo rollout"}
          </button>
        </>
      }
    >
      <div className="f">
        <label htmlFor="ro-flag">Flag (đang dùng)</label>
        <input
          className="inp"
          aria-label="Tìm flag đang dùng"
          placeholder="Tìm theo key"
          value={flagSearch}
          onChange={(e) => setFlagSearch(e.target.value)}
        />
        <select
          id="ro-flag"
          className="sel"
          value={flagId}
          onChange={(e) => {
            setFlagId(e.target.value);
            setRuleId("");
            setVariantId("");
          }}
        >
          <option value="">Chọn flag</option>
          {activeFlags.map((f) => (
            <option key={f.id} value={f.id}>
              {f.key}
            </option>
          ))}
        </select>
        {flagOff && (
          <span className="field-error">
            Flag đang tắt ở {env.name}: bật trước khi rollout.
          </span>
        )}
      </div>
      {flagId !== "" && (
        <div className="f">
          <label htmlFor="ro-rule">Rule sẽ ramp</label>
          <select
            id="ro-rule"
            className="sel"
            value={ruleId}
            onChange={(e) => {
              setRuleId(e.target.value);
              setVariantId("");
            }}
          >
            <option value="">Chọn rule</option>
            {rules.data?.rules.map((r, i) => (
              <option key={r.id} value={r.id}>
                Rule {i + 1}
                {r.description === null ? "" : `: ${r.description}`}
                {r.serve.kind === "distribution" ? "" : " (một variant)"}
              </option>
            ))}
          </select>
        </div>
      )}
      {rule !== undefined && rule.serve.kind === "distribution" && (
        <div className="f">
          <label htmlFor="ro-variant">Variant tăng dần</label>
          <select
            id="ro-variant"
            className="sel"
            value={variantId}
            onChange={(e) => setVariantId(e.target.value)}
          >
            <option value="">Chọn variant</option>
            {rule.serve.weights.map((w) => (
              <option key={w.variantId} value={w.variantId}>
                {variantKey(w.variantId)} (đang {w.weight / 1000}%)
              </option>
            ))}
          </select>
        </div>
      )}
      {pair?.kind === "invalid" && (
        <p className="field-error" role="alert">
          Không ramp được: {pair.reason}
        </p>
      )}
      {rule !== undefined && rule.serve.kind === "variant" && (
        <p className="field-error" role="alert">
          Rule này phục vụ thẳng một variant; chỉ ramp được rule chia tỉ lệ.
        </p>
      )}
      <div className="f">
        <label htmlFor="ro-workload">
          Workload (tên service trong cluster)
        </label>
        <div className="line">
          <input
            id="ro-workload"
            className="inp mono"
            placeholder="checkout-api"
            value={workloadName}
            onChange={(e) => {
              setWorkloadName(e.target.value.trim());
              probe.reset();
            }}
          />
          <button
            type="button"
            className="btn"
            disabled={!workloadOk || probe.isPending}
            onClick={() => probe.mutate()}
          >
            {probe.isPending ? "Đang kiểm tra..." : "Kiểm tra metric"}
          </button>
        </div>
        {workloadName !== "" && !workloadOk && (
          <span className="field-error">
            Tên chỉ gồm chữ thường, số, "-" và "." (DNS-1123).
          </span>
        )}
        {probed?.hasSeries === true && (
          <span className="c3">
            Có metric. Scrape mỗi {probed.scrapeIntervalSec}s; cửa sổ đo tối
            thiểu {probed.minMetricWindowSeconds}s.
          </span>
        )}
        {probe.isError && (
          <span className="field-error">
            {isApiError(probe.error) && probe.error.status === 503
              ? "Không tới được nguồn metrics của project. Rollout cần một Prometheus đang chạy."
              : messageOf(probe.error)}
          </span>
        )}
      </div>
      {probed?.hasSeries === false && (
        <MetricsSetupGuide
          runtime={project.languageRuntime}
          workload={workloadName}
          onRetry={() => probe.mutate()}
        />
      )}
      <fieldset className="fs">
        <legend>Nhịp</legend>
        <div className="grid-f">
          <NumberField
            id="ro-step"
            label="Mỗi bậc tăng (%)"
            value={stepPercent}
            onChange={setStepPercent}
            min={0.01}
            max={100}
            step={0.01}
          />
          <NumberField
            id="ro-dwell"
            label="Giữ mỗi bậc (giây)"
            hint="Đủ thời gian này mới lên bậc tiếp."
            value={stepInterval}
            onChange={setStepInterval}
            min={1}
          />
          <NumberField
            id="ro-analysis"
            label="Đo lại mỗi (giây)"
            hint="Vẫn đo trong lúc chờ lên bậc: vượt ngưỡng là rollback ngay."
            value={analysisInterval}
            onChange={setAnalysisInterval}
            min={1}
          />
          <NumberField
            id="ro-warm"
            label="Số request tối thiểu trước khi đánh giá"
            value={warmUp}
            onChange={setWarmUp}
            min={1}
          />
        </div>
      </fieldset>
      <fieldset className="fs">
        <legend>Ngưỡng rollback</legend>
        <div className="grid-f">
          <NumberField
            id="ro-err"
            label="Tỉ lệ lỗi tối đa (%)"
            value={errorRate}
            onChange={setErrorRate}
            min={0}
            max={100}
            step={0.1}
          />
          <NumberField
            id="ro-lat"
            label="Latency P99 tối đa (ms)"
            value={latency}
            onChange={setLatency}
            min={1}
          />
          <NumberField
            id="ro-minerr"
            label="Số lỗi tối thiểu để tính vượt"
            value={minErrors}
            onChange={setMinErrors}
            min={1}
          />
          <NumberField
            id="ro-breach"
            label="Vượt liên tiếp mấy lần thì rollback"
            value={breaches}
            onChange={setBreaches}
            min={1}
          />
        </div>
      </fieldset>
      {create.isError && (
        <p role="alert" className="field-error">
          {Object.values(fields)[0] ?? messageOf(create.error)}
        </p>
      )}
    </Dialog>
  );
}

function NumberField({
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
  /**
   * Bản Python của provider là plan riêng sau #26 (§6.8 "Bản Python") — chưa có gói nào
   * để cài. Nói thật điều đó thay vì in một dòng import không tồn tại.
   */
  const python = runtime.toLowerCase().startsWith("python");
  const code = python
    ? "# Middleware Python chưa phát hành (§6.8). Tạm thời: xuất histogram\n# http_server_request_duration_seconds kèm nhãn ff theo §6.6."
    : 'import { udpMetricsMiddleware } from "@udp/openfeature-provider/metrics";\n\napp.use(udpMetricsMiddleware());';
  return (
    <div className="alert amber" role="alert">
      <Icon of={CircleAlert} />
      <div>
        <b>Workload {workload} chưa xuất metric HTTP</b>
        <p className="c2" style={{ margin: "4px 0 8px" }}>
          Rollout cần so tỉ lệ lỗi giữa hai nhánh flag. Thêm middleware sau vào
          ứng dụng, deploy lại, rồi kiểm tra lại.
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
