import { useMutation } from "@tanstack/react-query";
import type {
  FlagDetailWire,
  PublicEnvironmentWire,
} from "@udp/shared-types/wire";
import { useState } from "react";
import { InfoTip } from "../../../components/InfoTip";
import { useMessages } from "../../../i18n";
import { messageOf } from "../../../lib/errors";
import { flagApi } from "../flag-api";
import { useProjectContext } from "../../project/ProjectLayout";
import { detailMessages } from "./detail.messages";

/**
 * Flag Evaluation Tester (§10.12): context giả → value, variant, reason, rule đã khớp.
 * Dùng CÙNG hàm đánh giá với SDK (I26), và thử được cả flag DRAFT.
 */
export function Tester({
  flag,
  env,
}: {
  flag: FlagDetailWire;
  env: PublicEnvironmentWire;
}) {
  const m = useMessages(detailMessages).tester;
  const { project } = useProjectContext();
  const [targetingKey, setTargetingKey] = useState("user-1");
  const [attrs, setAttrs] = useState("country=VN");

  const run = useMutation({
    mutationFn: () => {
      const context: Record<string, unknown> = { targetingKey };
      for (const line of attrs.split(/\n|;/)) {
        const [k, ...v] = line.split("=");
        const key = k?.trim() ?? "";
        if (key !== "") context[key] = v.join("=").trim();
      }
      return flagApi.evaluate(project.id, flag.id, env.id, context);
    },
  });
  const result = run.data;
  const variantKey = result?.evaluation.variant;

  return (
    <section aria-label={m.title}>
      <div className="sect">
        <h3>{m.title}</h3>
      </div>
      <div className="tester">
        <div className="f">
          {/* Nút giải thích nằm CẠNH nhãn, không trong nhãn: tên của ô chỉ là chữ của nhãn */}
          <span className="lbl-row">
            <label htmlFor="t-key">{m.targetingKey}</label>
            <InfoTip term="targetingKey" />
          </span>
          <input
            id="t-key"
            name="targetingKey"
            className="inp mono"
            autoComplete="off"
            spellCheck={false}
            value={targetingKey}
            onChange={(e) => setTargetingKey(e.target.value)}
          />
        </div>
        <div className="f">
          <label htmlFor="t-attrs">{m.attributes}</label>
          <textarea
            id="t-attrs"
            name="attributes"
            className="inp mono"
            rows={2}
            autoComplete="off"
            spellCheck={false}
            value={attrs}
            onChange={(e) => setAttrs(e.target.value)}
          />
        </div>
        <button
          type="button"
          className="btn"
          disabled={run.isPending}
          onClick={() => run.mutate()}
        >
          {run.isPending ? m.evaluating : m.evaluate}
        </button>
      </div>
      {/* Kết quả và lỗi được đọc lên khi có: người dùng bàn phím không phải tự dò xuống */}
      <div aria-live="polite">
        {run.isError && <p className="field-error">{messageOf(run.error)}</p>}
        {result !== undefined && (
          <dl className="props" aria-label={m.result}>
            <dt>{m.value}</dt>
            <dd className="mono">{JSON.stringify(result.evaluation.value)}</dd>
            <dt>{m.variant}</dt>
            <dd className="mono">{variantKey ?? m.none}</dd>
            <dt>{m.reason}</dt>
            <dd className="mono">{result.evaluation.reason}</dd>
            <dt>{m.matchedRule}</dt>
            <dd>
              {result.rule === undefined
                ? m.noRule
                : m.rule(result.rule.priority, result.rule.ruleType)}
            </dd>
            {result.draft && (
              <>
                <dt>{m.note}</dt>
                <dd className="c3">{m.draft}</dd>
              </>
            )}
          </dl>
        )}
      </div>
    </section>
  );
}
