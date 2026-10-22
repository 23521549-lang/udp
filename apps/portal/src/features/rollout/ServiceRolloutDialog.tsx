import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import {
  serviceLevelIssueOf,
  type ControlModeWire,
  type ServiceStrategy,
} from "@udp/shared-types/rollout";
import { useEffect, useState, type ReactNode } from "react";
import { Dialog } from "../../components/Dialog";
import { Field, focusFirstInvalid } from "../../components/Field";
import { InfoTip } from "../../components/InfoTip";
import { useMessages } from "../../i18n";
import { fieldErrorsOf, messageOf } from "../../lib/errors";
import { formatDuration } from "../../lib/format";
import { isApiError } from "../../lib/http";
import { qk } from "../../lib/query-keys";
import { domainApi } from "../domain/domain-api";
import { useProjectContext } from "../project/ProjectLayout";
import { rolloutApi, type CreateServiceRolloutInput } from "./rollout-api";
import {
  MetricsSetupGuide,
  NumberField,
  unplacedErrors,
  WORKLOAD_NAME,
  WorkloadField,
} from "./rollout-form";
import { rolloutMessages } from "./rollout.messages";

/** Tag image theo ngữ pháp Docker — cùng luật với Service 1 */
const IMAGE_TAG = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,62}$/;
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,64}$/;

const TOOL_LABEL: Record<string, string> = {
  "argo-rollouts": "Argo Rollouts",
  flagger: "Flagger",
  spinnaker: "Spinnaker",
};

const STRATEGIES: readonly ServiceStrategy[] = [
  "CANARY",
  "BLUE_GREEN",
  "ATTRIBUTE_SPLIT",
];

/** Khoá lỗi theo ô của máy chủ có ô trên form này — phần còn lại hiện ở câu chung */
const PLACED = [
  "workloadName",
  "imageTag",
  "trafficMatch.header",
  "trafficMatch.value",
  "stepPercent",
  "stepIntervalSeconds",
  "analysisIntervalSeconds",
  "warmUpRequests",
  "thresholds.errorRate",
  "thresholds.latencyP99Ms",
  "thresholds.minErrors",
  "thresholds.maxConsecutiveBreaches",
] as const;

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
  const { form, service: copy } = useMessages(rolloutMessages);
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
  const issueOf = (s: ServiceStrategy, m: ControlModeWire) => {
    const found = tool === null ? undefined : serviceLevelIssueOf(tool, m, s);
    return found === undefined ? undefined : copy.issue(found);
  };
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
  // [Plan #58 UX-39] Gửi hỏng: focus tới ô lỗi đầu tiên (sau khi lỗi đã vẽ dưới ô)
  useEffect(() => {
    if (create.error !== null) {
      focusFirstInvalid(document.querySelector<HTMLElement>("[role=dialog]"));
    }
  }, [create.error]);

  const workloadOk = WORKLOAD_NAME.test(workloadName);
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
  const unplaced = unplacedErrors(
    fields,
    ab ? PLACED : PLACED.filter((k) => !k.startsWith("trafficMatch")),
  );

  return (
    <Dialog
      title={form.title(env.name)}
      description={copy.description}
      onClose={onClose}
      wide
      footer={
        <>
          <button type="button" className="btn" data-close onClick={onClose}>
            {form.cancel}
          </button>
          <button
            type="button"
            className="btn pri"
            disabled={!ready}
            onClick={() => create.mutate()}
          >
            {create.isPending ? form.creating : form.create}
          </button>
        </>
      }
    >
      {scopePicker}
      {domains.isSuccess && tool === null && (
        <p className="field-error" role="alert">
          {copy.noTool}
        </p>
      )}
      {tool !== null && (
        <p className="c3">
          {copy.deliveryTool(<b>{TOOL_LABEL[tool] ?? tool}</b>)}
        </p>
      )}
      <div className="f">
        <span className="lbl">{copy.mode}</span>
        <div className="seg" role="group" aria-label={copy.mode}>
          {(["tool-driven", "udp-driven"] as const).map((value) => (
            <button
              key={value}
              type="button"
              aria-pressed={mode === value}
              onClick={() => setMode(value)}
            >
              {copy.modeOption[value]}
            </button>
          ))}
        </div>
        <span className="help">{copy.modeHint[mode]}</span>
      </div>
      <div className="f">
        <span className="lbl">
          {form.strategy}
          <InfoTip term="canary" />
        </span>
        <div className="seg" role="group" aria-label={form.strategy}>
          {STRATEGIES.map((value) => (
            <button
              key={value}
              type="button"
              aria-pressed={strategy === value}
              title={issueOf(value, mode)}
              disabled={issueOf(value, mode) !== undefined}
              onClick={() => setStrategy(value)}
            >
              {copy.strategy[value]}
            </button>
          ))}
        </div>
        {issue !== undefined && (
          <span className="field-error" role="alert">
            {issue}
          </span>
        )}
      </div>
      <WorkloadField
        id="sr-workload"
        value={workloadName}
        onChange={(name) => {
          setWorkloadName(name);
          probe.reset();
        }}
        checking={probe.isPending}
        onCheck={() => probe.mutate()}
        hint={
          probed?.hasSeries === true
            ? copy.hasMetrics(formatDuration(probed.minMetricWindowSeconds))
            : undefined
        }
        error={
          probe.isError
            ? isApiError(probe.error) && probe.error.status === 503
              ? copy.metricsUnreachable
              : messageOf(probe.error)
            : fields.workloadName
        }
      />
      {probed?.hasSeries === false && (
        <MetricsSetupGuide
          runtime={project.languageRuntime}
          workload={workloadName}
          onRetry={() => probe.mutate()}
        />
      )}
      <Field
        id="sr-tag"
        label={copy.tag}
        hint={copy.tagHint}
        error={imageTag !== "" && !tagOk ? copy.tagInvalid : fields.imageTag}
      >
        {(p) => (
          <input
            {...p}
            className="inp mono"
            placeholder="1.4.2…"
            value={imageTag}
            onChange={(e) => setImageTag(e.target.value.trim())}
          />
        )}
      </Field>
      {ab && (
        <div className="grid-f">
          <Field
            id="sr-header"
            label={copy.header}
            error={fields["trafficMatch.header"]}
          >
            {(p) => (
              <input
                {...p}
                className="inp mono"
                placeholder={copy.headerPlaceholder}
                value={header}
                onChange={(e) => setHeader(e.target.value.trim())}
              />
            )}
          </Field>
          <Field
            id="sr-header-value"
            label={copy.headerValue}
            error={fields["trafficMatch.value"]}
          >
            {(p) => (
              <input
                {...p}
                className="inp mono"
                placeholder="1…"
                value={headerValue}
                onChange={(e) => setHeaderValue(e.target.value)}
              />
            )}
          </Field>
        </div>
      )}
      <fieldset className="fs">
        <legend>
          {form.cadence}
          <InfoTip term="step" />
        </legend>
        <div className="grid-f">
          <NumberField
            id="sr-step"
            label={form.stepPercent}
            hint={copy.stepPercentHint}
            error={fields.stepPercent}
            value={stepPercent}
            onChange={setStepPercent}
            min={1}
            max={99}
          />
          <NumberField
            id="sr-dwell"
            label={form.dwell}
            hint={form.dwellHint}
            error={fields.stepIntervalSeconds}
            value={stepInterval}
            onChange={setStepInterval}
            min={1}
          />
          <NumberField
            id="sr-analysis"
            label={form.analysis}
            error={fields.analysisIntervalSeconds}
            value={analysisInterval}
            onChange={setAnalysisInterval}
            min={1}
          />
          <NumberField
            id="sr-warm"
            label={form.warmUp}
            error={fields.warmUpRequests}
            value={warmUp}
            onChange={setWarmUp}
            min={1}
          />
        </div>
      </fieldset>
      <fieldset className="fs">
        <legend>
          {form.thresholds}
          <InfoTip term="autoRollback" />
        </legend>
        <div className="grid-f">
          <NumberField
            id="sr-err"
            label={form.errorRate}
            error={fields["thresholds.errorRate"]}
            value={errorRate}
            onChange={setErrorRate}
            min={0}
            max={100}
            step={0.1}
          />
          <NumberField
            id="sr-lat"
            label={form.latency}
            hint={form.latencyHint}
            error={fields["thresholds.latencyP99Ms"]}
            value={latency}
            onChange={setLatency}
            min={1}
          />
          <NumberField
            id="sr-minerr"
            label={form.minErrors}
            error={fields["thresholds.minErrors"]}
            value={minErrors}
            onChange={setMinErrors}
            min={1}
          />
          <NumberField
            id="sr-breach"
            label={form.breaches}
            error={fields["thresholds.maxConsecutiveBreaches"]}
            value={breaches}
            onChange={setBreaches}
            min={1}
          />
        </div>
      </fieldset>
      {create.isError && (
        <p role="alert" className="field-error">
          {Object.keys(fields).length > 0
            ? [form.fixFields, ...unplaced].join(" ")
            : messageOf(create.error)}
        </p>
      )}
    </Dialog>
  );
}
