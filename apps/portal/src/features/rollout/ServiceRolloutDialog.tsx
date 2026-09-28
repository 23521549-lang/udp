import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import {
  serviceLevelIssue,
  type ControlModeWire,
  type ServiceStrategy,
} from "@udp/shared-types/rollout";
import { useState, type ReactNode } from "react";
import { Dialog } from "../../components/Dialog";
import { fieldErrorsOf, messageOf } from "../../lib/errors";
import { isApiError } from "../../lib/http";
import { qk } from "../../lib/query-keys";
import { domainApi } from "../domain/domain-api";
import { useProjectContext } from "../project/ProjectLayout";
import { rolloutApi, type CreateServiceRolloutInput } from "./rollout-api";
import { MetricsSetupGuide, NumberField } from "./rollout-form";

const DNS_1123 =
  /^[a-z0-9]([-a-z0-9]*[a-z0-9])?(\.[a-z0-9]([-a-z0-9]*[a-z0-9])?)*$/;
/** Tag image theo ngữ pháp Docker — cùng luật với Service 1 */
const IMAGE_TAG = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,62}$/;
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,64}$/;

const TOOL_LABEL: Record<string, string> = {
  "argo-rollouts": "Argo Rollouts",
  flagger: "Flagger",
  spinnaker: "Spinnaker",
};

const STRATEGIES: readonly [ServiceStrategy, string][] = [
  ["CANARY", "Canary"],
  ["BLUE_GREEN", "Blue/Green"],
  ["ATTRIBUTE_SPLIT", "Theo header"],
];

/**
 * Tạo rollout SERVICE_LEVEL (§10.9 "SERVICE_LEVEL: chọn workload + image tag mới") [Plan #51 QĐ-11].
 *
 * Tool là của environment (domain Progressive Delivery); ô chiến lược × chế độ mà tool đó không làm được bị khoá
 * kèm lý do — CÙNG hàm `serviceLevelIssue` mà Service 1 dùng để trả 422, nên form không mời một lựa chọn chắc
 * chắn bị từ chối. Bộ định tuyến (Istio hay không) chỉ Service 1 biết: ô đó do máy chủ nói.
 */
export function ServiceRolloutDialog({
  onClose,
  scopePicker,
}: {
  onClose: () => void;
  scopePicker: ReactNode;
}) {
  const { project, env } = useProjectContext();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const [strategy, setStrategy] = useState<ServiceStrategy>("CANARY");
  const [mode, setMode] = useState<ControlModeWire>("tool-driven");
  const [workloadName, setWorkloadName] = useState("");
  const [imageTag, setImageTag] = useState("");
  const [header, setHeader] = useState("");
  const [headerValue, setHeaderValue] = useState("");
  const [stepPercent, setStepPercent] = useState(20);
  const [stepInterval, setStepInterval] = useState(300);
  const [analysisInterval, setAnalysisInterval] = useState(30);
  const [warmUp, setWarmUp] = useState(100);
  const [errorRate, setErrorRate] = useState(5);
  const [latency, setLatency] = useState(500);
  const [minErrors, setMinErrors] = useState(5);
  const [breaches, setBreaches] = useState(2);

  const domains = useQuery({
    queryKey: qk.domains(project.id),
    queryFn: () => domainApi.list(project.id),
  });
  const delivery = domains.data?.domains.find(
    (d) => d.domainType === "PROGRESSIVE_DELIVERY",
  );
  const tool =
    delivery?.isEnabled === true ? (delivery.selectedTool ?? null) : null;
  const issueOf = (s: ServiceStrategy, m: ControlModeWire) =>
    tool === null ? undefined : serviceLevelIssue(tool, m, s);
  const issue = issueOf(strategy, mode);

  const probe = useMutation({
    mutationFn: () => rolloutApi.probe(project.id, env.id, workloadName),
  });
  const probed = probe.data?.probe;

  const ab = strategy === "ATTRIBUTE_SPLIT";
  const create = useMutation({
    mutationFn: () => {
      const body: CreateServiceRolloutInput = {
        scope: "SERVICE_LEVEL",
        envId: env.id,
        strategy,
        controlMode: mode,
        workloadName,
        imageTag,
        ...(ab ? { trafficMatch: { header, value: headerValue } } : {}),
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

  const workloadOk = DNS_1123.test(workloadName);
  const tagOk = IMAGE_TAG.test(imageTag);
  const matchOk =
    !ab || (HEADER_NAME.test(header) && headerValue.trim() !== "");
  const ready =
    tool !== null &&
    issue === undefined &&
    workloadOk &&
    tagOk &&
    matchOk &&
    Number.isInteger(stepPercent) &&
    probed?.hasSeries === true &&
    !create.isPending;

  return (
    <Dialog
      title={`Tạo rollout ở ${env.name}`}
      description="Canary theo phiên bản: phiên bản mới của một workload nhận traffic dần qua công cụ giao hàng của environment."
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
      {scopePicker}
      {domains.isSuccess && tool === null && (
        <p className="field-error" role="alert">
          Project chưa bật domain Progressive Delivery (Argo Rollouts hoặc
          Flagger): rollout theo phiên bản cần một công cụ giữ đường traffic.
        </p>
      )}
      {tool !== null && (
        <p className="c3">
          Công cụ giao hàng: <b>{TOOL_LABEL[tool] ?? tool}</b>
        </p>
      )}
      <div className="f">
        <span className="lbl">Chế độ</span>
        <div className="seg" role="group" aria-label="Chế độ">
          {(
            [
              ["tool-driven", "Công cụ tự quyết"],
              ["udp-driven", "UDP quyết"],
            ] as const
          ).map(([value, label]) => (
            <button
              key={value}
              type="button"
              aria-pressed={mode === value}
              onClick={() => setMode(value)}
            >
              {label}
            </button>
          ))}
        </div>
        <span className="help">
          {mode === "tool-driven"
            ? "Công cụ tự phân tích và tự promote; UDP hiển thị tiến độ, bạn vẫn promote hay rollback tay được."
            : "UDP so tỉ lệ lỗi phiên bản mới với phiên bản cũ và cho công cụ đi từng bậc."}
        </span>
      </div>
      <div className="f">
        <span className="lbl">Chiến lược</span>
        <div className="seg" role="group" aria-label="Chiến lược">
          {STRATEGIES.map(([value, label]) => (
            <button
              key={value}
              type="button"
              aria-pressed={strategy === value}
              title={issueOf(value, mode)}
              disabled={issueOf(value, mode) !== undefined}
              onClick={() => setStrategy(value)}
            >
              {label}
            </button>
          ))}
        </div>
        {issue !== undefined && (
          <span className="field-error" role="alert">
            {issue}
          </span>
        )}
      </div>
      <div className="f">
        <label htmlFor="sr-workload">
          Workload (tên service trong cluster)
        </label>
        <div className="line">
          <input
            id="sr-workload"
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
        {probed?.hasSeries === true && (
          <span className="c3">
            Có metric. Cửa sổ đo tối thiểu {probed.minMetricWindowSeconds}s.
          </span>
        )}
        {probe.isError && (
          <span className="field-error">
            {isApiError(probe.error) && probe.error.status === 503
              ? "Không tới được nguồn metrics của project."
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
      <div className="f">
        <label htmlFor="sr-tag">Tag image mới</label>
        <input
          id="sr-tag"
          className="inp mono"
          placeholder="1.4.2"
          value={imageTag}
          onChange={(e) => setImageTag(e.target.value.trim())}
        />
        <span className="help">
          Cùng repository với image đang chạy; chỉ tag đổi.
        </span>
        {imageTag !== "" && !tagOk && (
          <span className="field-error">Tag image không hợp lệ.</span>
        )}
      </div>
      {ab && (
        <div className="grid-f">
          <div className="f">
            <label htmlFor="sr-header">Header chọn nhóm</label>
            <input
              id="sr-header"
              className="inp mono"
              placeholder="X-Beta"
              value={header}
              onChange={(e) => setHeader(e.target.value.trim())}
            />
          </div>
          <div className="f">
            <label htmlFor="sr-header-value">Giá trị</label>
            <input
              id="sr-header-value"
              className="inp mono"
              placeholder="1"
              value={headerValue}
              onChange={(e) => setHeaderValue(e.target.value)}
            />
          </div>
        </div>
      )}
      <fieldset className="fs">
        <legend>Nhịp</legend>
        <div className="grid-f">
          <NumberField
            id="sr-step"
            label="Mỗi bậc tăng (%)"
            hint="Số nguyên: công cụ nhận trọng số nguyên."
            value={stepPercent}
            onChange={setStepPercent}
            min={1}
            max={99}
          />
          <NumberField
            id="sr-dwell"
            label="Giữ mỗi bậc (giây)"
            value={stepInterval}
            onChange={setStepInterval}
            min={1}
          />
          <NumberField
            id="sr-analysis"
            label="Đo lại mỗi (giây)"
            value={analysisInterval}
            onChange={setAnalysisInterval}
            min={1}
          />
          <NumberField
            id="sr-warm"
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
            id="sr-err"
            label="Tỉ lệ lỗi tối đa (%)"
            value={errorRate}
            onChange={setErrorRate}
            min={0}
            max={100}
            step={0.1}
          />
          <NumberField
            id="sr-lat"
            label="Latency P99 tối đa (ms)"
            value={latency}
            onChange={setLatency}
            min={1}
          />
          <NumberField
            id="sr-minerr"
            label="Số lỗi tối thiểu để tính vượt"
            value={minErrors}
            onChange={setMinErrors}
            min={1}
          />
          <NumberField
            id="sr-breach"
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
