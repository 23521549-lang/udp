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
import { messagesOf, useMessages } from "../../i18n";
import { fieldErrorsOf, messageOf } from "../../lib/errors";
import { browserTimeZone } from "../../lib/format";
import { isApiError } from "../../lib/http";
import { qk } from "../../lib/query-keys";
import { flagApi } from "../flag/flag-api";
import { useProjectContext } from "../project/ProjectLayout";
import { rolloutApi, type CreateFlagRolloutInput } from "./rollout-api";
import { MetricsSetupGuide, NumberField } from "./rollout-form";
import { rolloutMessages } from "./rollout.messages";
import { ServiceRolloutDialog } from "./ServiceRolloutDialog";

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
 * [Plan #46] Hai chiến lược ở mức flag (§7.2): CANARY tăng dần một rule phân phối; ATTRIBUTE_SPLIT
 * đưa nhóm khớp một rule theo thuộc tính/segment sang variant mới trong MỘT bậc, không tự quyết —
 * nên form ẩn nhịp bậc và ngưỡng rollback của nó. BLUE_GREEN "không áp dụng" ở mức flag.
 *
 * [Plan #51] Bước SCOPE của §10.9: "Theo flag" (hộp này) hay "Theo phiên bản" (`ServiceRolloutDialog`,
 * SERVICE_LEVEL qua Argo Rollouts/Flagger).
 */
type FlagStrategy = "CANARY" | "ATTRIBUTE_SPLIT";
type Scope = "FLAG_LEVEL" | "SERVICE_LEVEL";

export function CreateRolloutDialog({ onClose }: { onClose: () => void }) {
  const [scope, setScope] = useState<Scope>("FLAG_LEVEL");
  const picker = <ScopePicker value={scope} onChange={setScope} />;
  return scope === "FLAG_LEVEL" ? (
    <FlagRolloutDialog onClose={onClose} scopePicker={picker} />
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

function FlagRolloutDialog({
  onClose,
  scopePicker,
}: {
  onClose: () => void;
  scopePicker: ReactNode;
}) {
  const { form, flag: copy } = useMessages(rolloutMessages);
  const { project, env } = useProjectContext();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const tz = browserTimeZone();

  const [strategy, setStrategy] = useState<FlagStrategy>("CANARY");
  const split = strategy === "ATTRIBUTE_SPLIT";
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
        <span className="lbl">{form.strategy}</span>
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
      <div className="f">
        <label htmlFor="ro-flag">{copy.flag}</label>
        <input
          className="inp"
          aria-label={copy.search}
          placeholder={copy.searchPlaceholder}
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
          <option value="">{copy.chooseFlag}</option>
          {activeFlags.map((f) => (
            <option key={f.id} value={f.id}>
              {f.key}
            </option>
          ))}
        </select>
        {flagOff && (
          <span className="field-error">{copy.flagOff(env.name)}</span>
        )}
      </div>
      {flagId !== "" && (
        <div className="f">
          <label htmlFor="ro-rule">
            {split ? copy.ruleSplit : copy.ruleRamp}
          </label>
          <select
            id="ro-rule"
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
        </div>
      )}
      {rule !== undefined && rule.serve.kind === "distribution" && (
        <div className="f">
          <label htmlFor="ro-variant">
            {split ? copy.variantSplit : copy.variantRamp}
          </label>
          <select
            id="ro-variant"
            className="sel"
            value={variantId}
            onChange={(e) => setVariantId(e.target.value)}
          >
            <option value="">{copy.chooseVariant}</option>
            {rule.serve.weights.map((w) => (
              <option key={w.variantId} value={w.variantId}>
                {copy.variantOption(variantKey(w.variantId), w.weight / 1000)}
              </option>
            ))}
          </select>
        </div>
      )}
      {pair?.kind === "invalid" && (
        <p className="field-error" role="alert">
          {copy.cannotRamp(copy.rampReason(pair.code, pair.branches))}
        </p>
      )}
      {rule !== undefined && rule.serve.kind === "variant" && (
        <p className="field-error" role="alert">
          {copy.singleVariantRule}
        </p>
      )}
      <div className="f">
        <label htmlFor="ro-workload">{form.workload}</label>
        <div className="line">
          <input
            id="ro-workload"
            className="inp mono"
            placeholder={form.workloadPlaceholder}
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
            {probe.isPending ? form.checking : form.checkMetrics}
          </button>
        </div>
        {workloadName !== "" && !workloadOk && (
          <span className="field-error">{copy.workloadInvalid}</span>
        )}
        {probed?.hasSeries === true && (
          <span className="c3">
            {copy.hasMetrics(
              probed.scrapeIntervalSec,
              probed.minMetricWindowSeconds,
            )}
          </span>
        )}
        {probe.isError && (
          <span className="field-error">
            {isApiError(probe.error) && probe.error.status === 503
              ? copy.metricsUnreachable
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
      {!split && (
        <>
          <fieldset className="fs">
            <legend>{form.cadence}</legend>
            <div className="grid-f">
              <NumberField
                id="ro-step"
                label={form.stepPercent}
                value={stepPercent}
                onChange={setStepPercent}
                min={0.01}
                max={100}
                step={0.01}
              />
              <NumberField
                id="ro-dwell"
                label={form.dwell}
                hint={copy.dwellHint}
                value={stepInterval}
                onChange={setStepInterval}
                min={1}
              />
              <NumberField
                id="ro-analysis"
                label={form.analysis}
                hint={copy.analysisHint}
                value={analysisInterval}
                onChange={setAnalysisInterval}
                min={1}
              />
              <NumberField
                id="ro-warm"
                label={form.warmUp}
                value={warmUp}
                onChange={setWarmUp}
                min={1}
              />
            </div>
          </fieldset>
          <fieldset className="fs">
            <legend>{form.thresholds}</legend>
            <div className="grid-f">
              <NumberField
                id="ro-err"
                label={form.errorRate}
                value={errorRate}
                onChange={setErrorRate}
                min={0}
                max={100}
                step={0.1}
              />
              <NumberField
                id="ro-lat"
                label={form.latency}
                value={latency}
                onChange={setLatency}
                min={1}
              />
              <NumberField
                id="ro-minerr"
                label={form.minErrors}
                value={minErrors}
                onChange={setMinErrors}
                min={1}
              />
              <NumberField
                id="ro-breach"
                label={form.breaches}

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
          {Object.values(fields)[0] ?? messageOf(create.error)}
        </p>
      )}
    </Dialog>
  );
}
