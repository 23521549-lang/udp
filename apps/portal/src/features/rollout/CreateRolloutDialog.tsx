import {
  keepPreviousData,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { canaryPairOf } from "@udp/shared-types/rollout";
import { useEffect, useState, type ReactNode } from "react";
import { Dialog } from "../../components/Dialog";
import { Field, focusFirstInvalid } from "../../components/Field";
import { InfoTip } from "../../components/InfoTip";
import { messagesOf, useMessages } from "../../i18n";
import { fieldErrorsOf, messageOf } from "../../lib/errors";
import { browserTimeZone, formatDuration } from "../../lib/format";
import { isApiError } from "../../lib/http";
import { qk } from "../../lib/query-keys";
import { flagApi } from "../flag/flag-api";
import { useProjectContext } from "../project/ProjectLayout";
import { rolloutApi, type CreateFlagRolloutInput } from "./rollout-api";
import {
  MetricsSetupGuide,
  NumberField,
  unplacedErrors,
  WORKLOAD_NAME,
  WorkloadField,
} from "./rollout-form";
import { rolloutMessages } from "./rollout.messages";
import { ServiceRolloutDialog } from "./ServiceRolloutDialog";

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
 * [Plan #46] Hai chiến lược ở mức flag (§7.2): CANARY tăng dần một rule phân phối; ATTRIBUTE_SPLIT
 * đưa nhóm khớp một rule theo thuộc tính/segment sang variant mới trong MỘT bậc, không tự quyết —
 * nên form ẩn nhịp bậc và ngưỡng rollback của nó. BLUE_GREEN "không áp dụng" ở mức flag.
 *
 * [Plan #51] Bước SCOPE của §10.9: "Theo flag" (hộp này) hay "Theo phiên bản" (`ServiceRolloutDialog`,
 * SERVICE_LEVEL qua Argo Rollouts/Flagger).
 *
 * [Plan #58 UX-29] `flag`: mở từ panel của một flag ("Phát hành dần") thì flag đó đã được chọn sẵn.
 */
type FlagStrategy = "CANARY" | "ATTRIBUTE_SPLIT";
type Scope = "FLAG_LEVEL" | "SERVICE_LEVEL";

export function CreateRolloutDialog({
  onClose,
  flag,
}: {
  onClose: () => void;
  flag?: { id: string; key: string };
}) {
  const [scope, setScope] = useState<Scope>("FLAG_LEVEL");
  const picker = <ScopePicker value={scope} onChange={setScope} />;
  return scope === "FLAG_LEVEL" ? (
    <FlagRolloutDialog onClose={onClose} scopePicker={picker} preset={flag} />
  ) : (
    <ServiceRolloutDialog onClose={onClose} scopePicker={picker} />
  );
}

function ScopePicker({
  value,
  onChange,
}: {
  value: Scope;
  onChange: (scope: Scope) => void;
}) {
  const m = useMessages(rolloutMessages).form;
  return (
    <div className="f">
      <span className="lbl">{m.scope}</span>
      <div className="seg" role="group" aria-label={m.scope}>
        {(["FLAG_LEVEL", "SERVICE_LEVEL"] as const).map((scope) => (
          <button
            key={scope}
            type="button"
            aria-pressed={value === scope}
            onClick={() => onChange(scope)}
          >
            {m.scopeOption[scope]}
          </button>
        ))}
      </div>
    </div>
  );
}

const SPLIT_RULE_TYPES = new Set(["ATTRIBUTE_BASED", "SEGMENT"]);

/** Khoá lỗi theo ô của máy chủ có ô trên form này — phần còn lại hiện ở câu chung */
const PLACED = [
  "flagEnvConfigId",
  "targetingRuleId",
  "targetVariantId",
  "workloadName",
] as const;
/** Ô nhịp và ngưỡng — ẩn với ATTRIBUTE_SPLIT */
const PLACED_CADENCE = [
  "stepPercent",
  "stepIntervalSeconds",
  "analysisIntervalSeconds",
  "warmUpRequests",
  "thresholds.errorRate",
  "thresholds.latencyP99Ms",
  "thresholds.minErrors",
  "thresholds.maxConsecutiveBreaches",
] as const;

function FlagRolloutDialog({
  onClose,
  scopePicker,
  preset,
}: {
  onClose: () => void;
  scopePicker: ReactNode;
  preset: { id: string; key: string } | undefined;
}) {
  const { form, flag: copy } = useMessages(rolloutMessages);
  const { project, env } = useProjectContext();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const tz = browserTimeZone();

  const [strategy, setStrategy] = useState<FlagStrategy>("CANARY");
  const split = strategy === "ATTRIBUTE_SPLIT";
  const [flagId, setFlagId] = useState(preset?.id ?? "");
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
  const [flagSearch, setFlagSearch] = useState(preset?.key ?? "");
  const [flagTerm, setFlagTerm] = useState(preset?.key ?? "");
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
  const weights =
    rule?.serve.kind === "distribution" ? rule.serve.weights : undefined;
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
        throw new Error(messagesOf(rolloutMessages).flag.missingConfig);
      const body: CreateFlagRolloutInput = {
        scope: "FLAG_LEVEL",
        envId: env.id,
        strategy,
        flagEnvConfigId: envState.configId,
        targetingRuleId: ruleId,
        targetVariantId: variantId,
        workloadName,
        // ATTRIBUTE_SPLIT có đúng một bậc: nhóm khớp sang 100%
        stepPercent: split ? 100 : stepPercent,
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

  const activeFlags = flags.data?.flags ?? [];
  const workloadOk = WORKLOAD_NAME.test(workloadName);
  const flagOff = envState !== undefined && !envState.isEnabled;
  const ready =
    pair?.kind === "ok" &&
    workloadOk &&
    probed?.hasSeries === true &&
    !flagOff &&
    !create.isPending;

  const variantKey = (id: string) =>
    flag.data?.flag.variants.find((v) => v.id === id)?.key ?? id.slice(0, 8);
  const unplaced = unplacedErrors(
    fields,
    split ? PLACED : [...PLACED, ...PLACED_CADENCE],
  );

  return (
    <Dialog
      title={form.title(env.name)}
      description={split ? copy.descriptionSplit : copy.descriptionCanary}
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
      <div className="f">
        <span className="lbl">
          {form.strategy}
          <InfoTip term="canary" />
        </span>
        <div className="seg" role="group" aria-label={form.strategy}>
          {(["CANARY", "ATTRIBUTE_SPLIT"] as const).map((value) => (
            <button
              key={value}
              type="button"
              aria-pressed={strategy === value}
              onClick={() => {
                setStrategy(value);
                setRuleId("");
                setVariantId("");
              }}
            >
              {copy.strategy[value]}
            </button>
          ))}
        </div>
      </div>
      <Field
        id="ro-flag"
        label={copy.flag}
        error={flagOff ? copy.flagOff(env.name) : fields.flagEnvConfigId}
      >
        {(p) => (
          <>
            <input
              className="inp"
              aria-label={copy.search}
              placeholder={copy.searchPlaceholder}
              value={flagSearch}
              onChange={(e) => setFlagSearch(e.target.value)}
            />
            <select
              {...p}
              className="sel"
              value={flagId}
              onChange={(e) => {
                setFlagId(e.target.value);
                setRuleId("");
                setVariantId("");
              }}
            >
              <option value="">{copy.chooseFlag}</option>
              {activeFlags.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.key}
                </option>
              ))}
            </select>
          </>
        )}
      </Field>
      {flagId !== "" && (
        <Field
          id="ro-rule"
          label={split ? copy.ruleSplit : copy.ruleRamp}
          error={
            rule?.serve.kind === "variant"
              ? copy.singleVariantRule
              : fields.targetingRuleId
          }
        >
          {(p) => (
            <select
              {...p}
              className="sel"
              value={ruleId}
              onChange={(e) => {
                setRuleId(e.target.value);
                setVariantId("");
              }}
            >
              <option value="">{copy.chooseRule}</option>
              {rules.data?.rules
                .filter((r) => !split || SPLIT_RULE_TYPES.has(r.ruleType))
                .map((r, i) => (
                  <option key={r.id} value={r.id}>
                    {copy.ruleOption(
                      i + 1,
                      r.description,
                      r.serve.kind !== "distribution",
                    )}
                  </option>
                ))}
            </select>
          )}
        </Field>
      )}
      {weights !== undefined && (
        <Field
          id="ro-variant"
          label={split ? copy.variantSplit : copy.variantRamp}
          error={
            pair?.kind === "invalid"
              ? copy.cannotRamp(copy.rampReason(pair.code, pair.branches))
              : fields.targetVariantId
          }
        >
          {(p) => (
            <select
              {...p}
              className="sel"
              value={variantId}
              onChange={(e) => setVariantId(e.target.value)}
            >
              <option value="">{copy.chooseVariant}</option>
              {weights.map((w) => (
                <option key={w.variantId} value={w.variantId}>
                  {copy.variantOption(variantKey(w.variantId), w.weight / 1000)}
                </option>
              ))}
            </select>
          )}
        </Field>
      )}
      <WorkloadField
        id="ro-workload"
        value={workloadName}
        onChange={(name) => {
          setWorkloadName(name);
          probe.reset();
        }}
        checking={probe.isPending}
        onCheck={() => probe.mutate()}
        hint={
          probed?.hasSeries === true
            ? copy.hasMetrics(
                formatDuration(probed.scrapeIntervalSec),
                formatDuration(probed.minMetricWindowSeconds),
              )
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
      {!split && (
        <>
          <fieldset className="fs">
            <legend>
              {form.cadence}
              <InfoTip term="step" />
            </legend>
            <div className="grid-f">
              <NumberField
                id="ro-step"
                label={form.stepPercent}
                error={fields.stepPercent}
                value={stepPercent}
                onChange={setStepPercent}
                min={0.01}
                max={100}
                step={0.01}
              />
              <NumberField
                id="ro-dwell"
                label={form.dwell}
                hint={form.dwellHint}
                error={fields.stepIntervalSeconds}
                value={stepInterval}
                onChange={setStepInterval}
                min={1}
              />
              <NumberField
                id="ro-analysis"
                label={form.analysis}
                hint={copy.analysisHint}
                error={fields.analysisIntervalSeconds}
                value={analysisInterval}
                onChange={setAnalysisInterval}
                min={1}
              />
              <NumberField
                id="ro-warm"
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
                id="ro-err"
                label={form.errorRate}
                error={fields["thresholds.errorRate"]}
                value={errorRate}
                onChange={setErrorRate}
                min={0}
                max={100}
                step={0.1}
              />
              <NumberField
                id="ro-lat"
                label={form.latency}
                hint={form.latencyHint}
                error={fields["thresholds.latencyP99Ms"]}
                value={latency}
                onChange={setLatency}
                min={1}
              />
              <NumberField
                id="ro-minerr"
                label={form.minErrors}
                error={fields["thresholds.minErrors"]}
                value={minErrors}
                onChange={setMinErrors}
                min={1}
              />
              <NumberField
                id="ro-breach"
                label={form.breaches}
                error={fields["thresholds.maxConsecutiveBreaches"]}
                value={breaches}
                onChange={setBreaches}
                min={1}
              />
            </div>
          </fieldset>
        </>
      )}
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
