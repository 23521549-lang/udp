import { useQuery } from "@tanstack/react-query";
import {
  ATTRIBUTE_OPERATORS,
  type AttributeCondition,
  type AttributeOperator,
  type RuleType,
} from "@udp/shared-types/condition";
import type { FlagVariantWire } from "@udp/shared-types/wire";
import { ArrowDown, ArrowUp, Plus, Trash2, X } from "lucide-react";
import { useState } from "react";
import { Icon } from "../../components/Icon";
import { useMessages } from "../../i18n";
import { formatPercent } from "../../lib/format";
import { qk } from "../../lib/query-keys";
import { segmentApi } from "../segment/segment-api";
import {
  evenDistribution,
  percentOf,
  setWeight,
  TOTAL_WEIGHT,
  weightOf,
  weightSum,
  withRuleType,
  type RuleDraft,
} from "./rules-model";
import { rulesMessages } from "./rules.messages";

/**
 * Một rule = hai nửa TÁCH RỜI (§10.8, v4): "Nếu" (ai khớp) và "Thì" (phục vụ gì). Tách ra
 * thì "10% người dùng ở VN" diễn đạt được, và `distribution` chính là thứ rollout
 * FLAG_LEVEL ramp (§7.7).
 */

/** Thứ tự các loại "ai khớp" trong ô chọn; nhãn ở `rulesMessages.ruleType` */
const RULE_TYPES: RuleType[] = [
  "ALL",
  "USER_BASED",
  "ATTRIBUTE_BASED",
  "SEGMENT",
];

const VARIANT_COLORS = ["var(--v1)", "var(--v2)", "var(--v3)", "var(--v4)"];
export const variantColor = (i: number): string =>
  VARIANT_COLORS[i % VARIANT_COLORS.length] ?? "var(--v1)";

const LIST_OPS = new Set<AttributeOperator>(["in", "nin"]);
const NUMBER_OPS = new Set<AttributeOperator>(["gt", "gte", "lt", "lte"]);

function valueFor(op: AttributeOperator, text: string): unknown {
  if (LIST_OPS.has(op)) {
    return text
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s !== "");
  }
  if (NUMBER_OPS.has(op)) {
    const n = Number(text);
    return text.trim() === "" || Number.isNaN(n) ? text : n;
  }
  return text;
}

function textOf(value: unknown): string {
  if (Array.isArray(value)) return value.join(", ");
  return value === undefined || value === null ? "" : String(value);
}

export function RuleCard({
  index,
  total,
  rule,
  variants,
  projectId,
  problem,
  readOnly,
  onChange,
  onMove,
  onRemove,
}: {
  index: number;
  total: number;
  rule: RuleDraft;
  variants: FlagVariantWire[];
  projectId: string;
  problem: string | undefined;
  readOnly: boolean;
  onChange: (next: RuleDraft) => void;
  onMove: (delta: -1 | 1) => void;
  onRemove: () => void;
}) {
  const m = useMessages(rulesMessages);
  const label = m.rule(index + 1);
  const problemId = `${rule.localKey}-problem`;
  return (
    <div
      className="rule"
      role="group"
      aria-label={label}
      aria-describedby={problem === undefined ? undefined : problemId}
    >
      <div className="rule-h">
        <span className="idx">{index + 1}</span>
        <input
          aria-label={m.description(label)}
          placeholder={m.descriptionPlaceholder}
          value={rule.description ?? ""}
          disabled={readOnly}
          onChange={(e) => onChange({ ...rule, description: e.target.value })}
        />
        <button
          type="button"
          className="ib"
          aria-label={m.moveUp(label)}
          disabled={readOnly || index === 0}
          onClick={() => onMove(-1)}
        >
          <Icon of={ArrowUp} />
        </button>
        <button
          type="button"
          className="ib"
          aria-label={m.moveDown(label)}
          disabled={readOnly || index === total - 1}
          onClick={() => onMove(1)}
        >
          <Icon of={ArrowDown} />
        </button>
        <button
          type="button"
          className="ib"
          aria-label={m.remove(label)}
          disabled={readOnly}
          onClick={onRemove}
        >
          <Icon of={Trash2} />
        </button>
      </div>
      <div className="rule-b">
        <span className="w">{m.if}</span>
        <div className="line">
          <select
            className="sel"
            aria-label={m.conditionType(label)}
            value={rule.ruleType}
            disabled={readOnly}
            onChange={(e) =>
              onChange(withRuleType(rule, e.target.value as RuleType))
            }
          >
            {RULE_TYPES.map((t) => (
              <option key={t} value={t}>
                {m.ruleType[t]}
              </option>
            ))}
          </select>
          <ConditionEditor
            rule={rule}
            label={label}
            projectId={projectId}
            readOnly={readOnly}
            onChange={(condition) => onChange({ ...rule, condition })}
          />
        </div>
        <span className="w">{m.then}</span>
        <ServeEditor
          rule={rule}
          label={label}
          variants={variants}
          readOnly={readOnly}
          onChange={(serve) => onChange({ ...rule, serve })}
        />
        <span
          id={problemId}
          className="field-error"
          style={{ gridColumn: "2" }}
          aria-live="polite"
        >
          {problem ?? ""}
        </span>
      </div>
    </div>
  );
}

function ConditionEditor({
  rule,
  label,
  projectId,
  readOnly,
  onChange,
}: {
  rule: RuleDraft;
  label: string;
  projectId: string;
  readOnly: boolean;
  onChange: (condition: unknown) => void;
}) {
  const m = useMessages(rulesMessages);
  switch (rule.ruleType) {
    case "ALL":
      return <span className="c3">{m.matchesEveryone}</span>;
    case "USER_BASED": {
      const ids = (rule.condition as { userIds?: string[] }).userIds ?? [];
      return (
        <TagInput
          label={m.userList(label)}
          values={ids}
          readOnly={readOnly}
          onChange={(userIds) => onChange({ userIds })}
        />
      );
    }
    case "SEGMENT":
      return (
        <SegmentPicker
          projectId={projectId}
          label={label}
          value={(rule.condition as { segmentId?: string }).segmentId ?? ""}
          readOnly={readOnly}
          onChange={(segmentId) => onChange({ segmentId })}
        />
      );
    case "ATTRIBUTE_BASED":
      return (
        <AttributeConditions
          label={label}
          value={(rule.condition as { all?: AttributeCondition[] }).all ?? []}
          readOnly={readOnly}
          onChange={(all) => onChange({ all })}
        />
      );
  }
}

/** Danh sách điều kiện thuộc tính (AND) — dùng chung cho rule và segment */
export function AttributeConditions({
  label,
  value: all,
  readOnly,
  onChange: set,
}: {
  label: string;
  value: AttributeCondition[];
  readOnly: boolean;
  onChange: (next: AttributeCondition[]) => void;
}) {
  const m = useMessages(rulesMessages);
  return (
    <div className="conds">
      {all.map((c, i) => (
        <div key={i} className="line">
          {i > 0 && <span className="c3">{m.and}</span>}
          <input
            className="inp mono"
            aria-label={m.attribute(i + 1, label)}
            placeholder={m.attributePlaceholder}
            value={c.attribute}
            disabled={readOnly}
            onChange={(e) =>
              set(
                all.map((x, j) =>
                  j === i ? { ...x, attribute: e.target.value } : x,
                ),
              )
            }
          />
          <select
            className="sel"
            aria-label={m.operatorOf(i + 1, label)}
            value={c.operator}
            disabled={readOnly}
            onChange={(e) => {
              const operator = e.target.value as AttributeOperator;
              set(
                all.map((x, j) =>
                  j === i
                    ? ({
                        attribute: x.attribute,
                        operator,
                        value: valueFor(operator, textOf(x.value)),
                      } as AttributeCondition)
                    : x,
                ),
              );
            }}
          >
            {ATTRIBUTE_OPERATORS.map((op) => (
              <option key={op} value={op}>
                {m.operator[op]}
              </option>
            ))}
          </select>
          <input
            className="inp"
            aria-label={m.value(i + 1, label)}
            placeholder={
              LIST_OPS.has(c.operator)
                ? m.listValuePlaceholder
                : m.valuePlaceholder
            }
            value={textOf(c.value)}
            disabled={readOnly}
            onChange={(e) =>
              set(
                all.map((x, j) =>
                  j === i
                    ? ({
                        ...x,
                        value: valueFor(x.operator, e.target.value),
                      } as AttributeCondition)
                    : x,
                ),
              )
            }
          />
          {all.length > 1 && (
            <button
              type="button"
              className="ib"
              aria-label={m.removeCondition(i + 1, label)}
              disabled={readOnly}
              onClick={() => set(all.filter((_, j) => j !== i))}
            >
              <Icon of={X} />
            </button>
          )}
        </div>
      ))}
      {!readOnly && (
        <button
          type="button"
          className="btn"
          onClick={() =>
            set([...all, { attribute: "", operator: "eq", value: "" }])
          }
        >
          <Icon of={Plus} />
          {m.addCondition}
        </button>
      )}
    </div>
  );
}

export function TagInput({
  label,
  values,
  readOnly,
  onChange,
}: {
  label: string;
  values: string[];
  readOnly: boolean;
  onChange: (values: string[]) => void;
}) {
  const m = useMessages(rulesMessages);
  const [text, setText] = useState("");
  const commit = () => {
    const parts = text
      .split(/[,\s]+/)
      .map((s) => s.trim())
      .filter((s) => s !== "" && !values.includes(s));
    if (parts.length > 0) onChange([...values, ...parts]);
    setText("");
  };
  return (
    <div className="tagin">
      {values.map((v) => (
        <span key={v} className="c">
          {v}
          {!readOnly && (
            <button
              type="button"
              aria-label={m.removeTag(v)}
              onClick={() => onChange(values.filter((x) => x !== v))}
            >
              <Icon of={X} size={10} />
            </button>
          )}
        </span>
      ))}
      <input
        aria-label={label}
        placeholder={values.length === 0 ? m.tagPlaceholder : ""}
        value={text}
        disabled={readOnly}
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === ",") {
            e.preventDefault();
            commit();
          }
        }}
      />
    </div>
  );
}

function SegmentPicker({
  projectId,
  label,
  value,
  readOnly,
  onChange,
}: {
  projectId: string;
  label: string;
  value: string;
  readOnly: boolean;
  onChange: (segmentId: string) => void;
}) {
  const m = useMessages(rulesMessages);
  const segments = useQuery({
    queryKey: qk.segments(projectId),
    queryFn: () => segmentApi.list(projectId),
  });
  return (
    <select
      className="sel"
      aria-label={m.segmentOf(label)}
      value={value}
      disabled={readOnly}
      onChange={(e) => onChange(e.target.value)}
    >
      <option value="">{m.chooseSegment}</option>
      {segments.data?.segments.map((s) => (
        <option key={s.id} value={s.id}>
          {s.name}
        </option>
      ))}
    </select>
  );
}

function ServeEditor({
  rule,
  label,
  variants,
  readOnly,
  onChange,
}: {
  rule: RuleDraft;
  label: string;
  variants: FlagVariantWire[];
  readOnly: boolean;
  onChange: (serve: RuleDraft["serve"]) => void;
}) {
  const m = useMessages(rulesMessages);
  const serve = rule.serve;
  return (
    <div
      className="line"
      style={{ flexDirection: "column", alignItems: "stretch" }}
    >
      <div className="seg" role="group" aria-label={m.serveMode(label)}>
        <button
          type="button"
          aria-pressed={serve.kind === "variant"}
          disabled={readOnly}
          onClick={() =>
            onChange({ kind: "variant", variantId: variants[0]?.id ?? "" })
          }
        >
          {m.oneVariant}
        </button>
        <button
          type="button"
          aria-pressed={serve.kind === "distribution"}
          disabled={readOnly}
          onClick={() => onChange(evenDistribution(variants))}
        >
          {m.split}
        </button>
      </div>
      {serve.kind === "variant" ? (
        <select
          className="sel"
          aria-label={m.servedVariant(label)}
          value={serve.variantId}
          disabled={readOnly}
          onChange={(e) =>
            onChange({ kind: "variant", variantId: e.target.value })
          }
        >
          <option value="">{m.chooseVariant}</option>
          {variants.map((v) => (
            <option key={v.id} value={v.id}>
              {v.key}
            </option>
          ))}
        </select>
      ) : (
        <Distribution
          serve={serve}
          label={label}
          variants={variants}
          readOnly={readOnly}
          onChange={onChange}
        />
      )}
    </div>
  );
}

function Distribution({
  serve,
  label,
  variants,
  readOnly,
  onChange,
}: {
  serve: Extract<RuleDraft["serve"], { kind: "distribution" }>;
  label: string;
  variants: FlagVariantWire[];
  readOnly: boolean;
  onChange: (serve: RuleDraft["serve"]) => void;
}) {
  const m = useMessages(rulesMessages);
  const sum = weightSum(serve);
  const keyOf = (id: string) => variants.find((v) => v.id === id)?.key ?? id;
  return (
    <div className="dist">
      <div className="bar2" aria-hidden="true">
        {serve.weights.map((w, i) => (
          <i
            key={w.variantId}
            style={{
              width: `${String(percentOf(w.weight))}%`,
              background: variantColor(i),
            }}
          />
        ))}
      </div>
      {serve.weights.map((w, i) => (
        <div key={w.variantId} className="dr">
          <span className="vd" style={{ background: variantColor(i) }} />
          <span className="mono">{keyOf(w.variantId)}</span>
          <input
            type="range"
            min={0}
            max={100}
            step={0.1}
            aria-label={m.dragShare(keyOf(w.variantId), label)}
            value={percentOf(w.weight)}
            disabled={readOnly}
            onChange={(e) =>
              onChange(
                setWeight(serve, w.variantId, weightOf(Number(e.target.value))),
              )
            }
          />
          {/* Ô số cạnh thanh trượt: gõ đúng 33,3 thay vì dò bằng chuột từng 0,1 */}
          <input
            type="number"
            className="inp num pct-in"
            inputMode="decimal"
            min={0}
            max={100}
            step={0.1}
            aria-label={m.share(keyOf(w.variantId), label)}
            value={percentOf(w.weight)}
            disabled={readOnly}
            onChange={(e) =>
              onChange(
                setWeight(
                  serve,
                  w.variantId,
                  weightOf(Math.min(100, Math.max(0, Number(e.target.value)))),
                ),
              )
            }
          />
        </div>
      ))}
      <div
        className={sum === TOTAL_WEIGHT ? "sum" : "sum bad"}
        role={sum === TOTAL_WEIGHT ? undefined : "alert"}
      >
        <span>{m.total}</span>
        <span className="num">{formatPercent(percentOf(sum))}</span>
      </div>
    </div>
  );
}
