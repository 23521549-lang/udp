import { useMutation } from "@tanstack/react-query";
import type {
  FlagDetailWire,
  PublicEnvironmentWire,
} from "@udp/shared-types/wire";
import { useState } from "react";
import { messageOf } from "../../../lib/errors";
import { flagApi } from "../flag-api";
import { useProjectContext } from "../../project/ProjectLayout";

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
    <section aria-label="Thử đánh giá">
      <div className="sect">
        <h3>Thử đánh giá</h3>
      </div>
      <div className="tester">
        <div className="f">
          <label htmlFor="t-key">targetingKey</label>
          <input
            id="t-key"
            className="inp mono"
            value={targetingKey}
            onChange={(e) => setTargetingKey(e.target.value)}
          />
        </div>
        <div className="f">
          <label htmlFor="t-attrs">Thuộc tính (mỗi dòng key=value)</label>
          <textarea
            id="t-attrs"
            className="inp mono"
            rows={2}
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
          {run.isPending ? "Đang đánh giá..." : "Đánh giá"}
        </button>
      </div>
      {run.isError && <p className="field-error">{messageOf(run.error)}</p>}
      {result !== undefined && (
        <dl className="props" aria-label="Kết quả đánh giá">
          <dt>Giá trị</dt>
          <dd className="mono">{JSON.stringify(result.evaluation.value)}</dd>
          <dt>Variant</dt>
          <dd className="mono">{variantKey ?? "(không có)"}</dd>
          <dt>Lý do</dt>
          <dd className="mono">{result.evaluation.reason}</dd>
          <dt>Rule khớp</dt>
          <dd>
            {result.rule === undefined
              ? "Không rule nào"
              : `Rule ưu tiên ${String(result.rule.priority)} (${result.rule.ruleType})`}
          </dd>
          {result.draft && (
            <>
              <dt>Lưu ý</dt>
              <dd className="c3">Flag còn nháp: SDK chưa thấy nó.</dd>
            </>
          )}
        </dl>
      )}
    </section>
  );
}
