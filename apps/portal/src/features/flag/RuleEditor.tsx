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

/**
 * Một rule = hai nửa TÁCH RỜI (§10.8, v4): "Nếu" (ai khớp) và "Thì" (phục vụ gì). Tách ra
 * thì "10% người dùng ở VN" diễn đạt được, và `distribution` chính là thứ rollout
 * FLAG_LEVEL ramp (§7.7).
 */

const RULE_TYPE_LABEL: Record<RuleType, string> = {
  ALL: "Mọi người",
  USER_BASED: "Người dùng cụ thể",
  ATTRIBUTE_BASED: "Thuộc tính",
  SEGMENT: "Segment",
};

const OPERATOR_LABEL: Record<AttributeOperator, string> = {
  eq: "bằng",
  neq: "khác",
  in: "thuộc",
  nin: "không thuộc",
  gt: ">",
  gte: "≥",
  lt: "<",
  lte: "≤",
  contains: "chứa",
  startsWith: "bắt đầu bằng",
  endsWith: "kết thúc bằng",
  semverGt: "semver >",
  semverLt: "semver <",
  regex: "khớp regex",
};

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
  const label = `Rule ${String(index + 1)}`;
  return (
    <div className="rule" role="group" aria-label={label}>
      <div className="rule-h">
        <span className="idx">{index + 1}</span>
        <input
          aria-label={`Mô tả ${label}`}
          placeholder="Mô tả rule"
          value={rule.description ?? ""}
          disabled={readOnly}
          onChange={(e) => onChange({ ...rule, description: e.target.value })}
        />
        <button
          type="button"
          className="ib"
          aria-label={`Đưa ${label} lên`}
          disabled={readOnly || index === 0}
          onClick={() => onMove(-1)}
        >
          <Icon of={ArrowUp} />
        </button>
        <button
          type="button"
          className="ib"
          aria-label={`Đưa ${label} xuống`}
          disabled={readOnly || index === total - 1}
          onClick={() => onMove(1)}
        >
          <Icon of={ArrowDown} />
        </button>
        <button
          type="button"
          className="ib"
          aria-label={`Xoá ${label}`}
          disabled={readOnly}
          onClick={onRemove}
        >
          <Icon of={Trash2} />
        </button>
      </div>
      <div className="rule-b">
        <span className="w">Nếu</span>
        <div className="line">
          <select
            className="sel"
            aria-label={`Loại điều kiện ${label}`}
            value={rule.ruleType}
            disabled={readOnly}
            onChange={(e) =>
              onChange(withRuleType(rule, e.target.value as RuleType))
            }
          >
            {(Object.keys(RULE_TYPE_LABEL) as RuleType[]).map((t) => (
              <option key={t} value={t}>
                {RULE_TYPE_LABEL[t]}
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
        <span className="w">Thì</span>
        <ServeEditor
          rule={rule}
          label={label}
          variants={variants}
          readOnly={readOnly}
          onChange={(serve) => onChange({ ...rule, serve })}
        />
        {problem !== undefined && (
          <span className="field-error" style={{ gridColumn: "2" }}>
            {problem}
          </span>
        )}
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
  switch (rule.ruleType) {
    case "ALL":
      return <span className="c3">khớp mọi người dùng</span>;
    case "USER_BASED": {
      const ids = (rule.condition as { userIds?: string[] }).userIds ?? [];
      return (
        <TagInput
          label={`Danh sách người dùng ${label}`}
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
  return (
    <div className="conds">
      {all.map((c, i) => (
        <div key={i} className="line">
          {i > 0 && <span className="c3">và</span>}
          <input
            className="inp mono"
            aria-label={`Thuộc tính ${String(i + 1)} của ${label}`}
            placeholder="country"
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
            aria-label={`Toán tử ${String(i + 1)} của ${label}`}
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
                {OPERATOR_LABEL[op]}
              </option>
            ))}
          </select>
          <input
            className="inp"
            aria-label={`Giá trị ${String(i + 1)} của ${label}`}
            placeholder={LIST_OPS.has(c.operator) ? "VN, TH" : "VN"}
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
              aria-label={`Bỏ điều kiện ${String(i + 1)} của ${label}`}
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
          Thêm điều kiện
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
              aria-label={`Bỏ ${v}`}
              onClick={() => onChange(values.filter((x) => x !== v))}
            >
              <Icon of={X} size={10} />
            </button>
          )}
        </span>
      ))}
      <input
        aria-label={label}
        placeholder={values.length === 0 ? "user-1, user-2" : ""}
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
  const segments = useQuery({
    queryKey: qk.segments(projectId),
    queryFn: () => segmentApi.list(projectId),
  });
  return (
    <select
      className="sel"
      aria-label={`Segment của ${label}`}
      value={value}
      disabled={readOnly}
      onChange={(e) => onChange(e.target.value)}
    >
      <option value="">Chọn segment</option>
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
  const serve = rule.serve;
  return (
    <div
      className="line"
      style={{ flexDirection: "column", alignItems: "stretch" }}
    >
      <div className="seg" role="group" aria-label={`Cách phục vụ ${label}`}>
        <button
          type="button"
          aria-pressed={serve.kind === "variant"}
          disabled={readOnly}
          onClick={() =>
            onChange({ kind: "variant", variantId: variants[0]?.id ?? "" })
          }
        >
          Một variant
        </button>
        <button
          type="button"
          aria-pressed={serve.kind === "distribution"}
          disabled={readOnly}
          onClick={() => onChange(evenDistribution(variants))}
        >
          Chia tỉ lệ
        </button>
      </div>
      {serve.kind === "variant" ? (
        <select
          className="sel"
          aria-label={`Variant phục vụ ${label}`}
          value={serve.variantId}
          disabled={readOnly}
          onChange={(e) =>
            onChange({ kind: "variant", variantId: e.target.value })
          }
        >
          <option value="">Chọn variant</option>
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
            aria-label={`Tỉ lệ ${keyOf(w.variantId)} của ${label}`}
            value={percentOf(w.weight)}
            disabled={readOnly}
            onChange={(e) =>
              onChange(
                setWeight(serve, w.variantId, weightOf(Number(e.target.value))),
              )
            }
          />
          <span className="pct">{percentOf(w.weight)}%</span>
        </div>
      ))}
      <div
        className={sum === TOTAL_WEIGHT ? "sum" : "sum bad"}
        role={sum === TOTAL_WEIGHT ? undefined : "alert"}
      >
        <span>Tổng</span>
        <span>{percentOf(sum)}%</span>
      </div>
    </div>
  );
}
