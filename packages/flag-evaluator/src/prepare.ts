import {
  flagServeWireSchema,
  readConditionSchemas,
  readSegmentConditionsSchema,
  RULE_TYPES,
  type FlagServeWire,
  type RuleType,
} from "@udp/shared-types";
import { z } from "zod";
import {
  attributeOf,
  compileCondition,
  nfc,
  type CompiledCondition,
  type EvalContext,
} from "./conditions.js";
import type { Snapshot } from "./snapshot.js";

/**
 * Snapshot ĐÃ DỰNG cho đánh giá (§6.5 [v4.6]) — một lần mỗi `configVersion`,
 * không phải mỗi lượt: flag theo `Map`, rule đã parse và biên dịch, `userIds`
 * thành `Set`, variant thành bảng tra.
 *
 * Đầu vào đến từ MẠNG (SDK nhận `/sdk/config`, áp delta), nên mọi phần được
 * parse lại ở đây và KHÔNG phần nào được ném (I33): flag, rule hay segment sai
 * hình được đánh dấu HỎNG, và đánh giá chạm tới nó trả ERROR `GENERAL`. Không bỏ
 * qua im lặng — ADR-03(d): bỏ một rule đổi luôn rule nào khớp tiếp theo, tức
 * phục vụ sai variant mà không ai biết.
 */

export interface PreparedRule {
  id: string;
  /** `undefined` ⇒ rule hỏng */
  matches:
    | ((context: EvalContext, segments: SegmentMatcher) => boolean | "broken")
    | undefined;
  serve: FlagServeWire | undefined;
  bucketSalt: string;
}

export interface PreparedFlagEntry {
  kind: "flag";
  key: string;
  type: string;
  isEnabled: boolean;
  stickinessAttribute: string;
  variants: ReadonlyMap<string, unknown>;
  defaultVariantKey: string;
  rules: readonly PreparedRule[];
}

export type PreparedEntry =
  | PreparedFlagEntry
  | { kind: "tombstone"; key: string }
  | { kind: "broken"; key: string };

interface PreparedSegment {
  userIds: ReadonlySet<string>;
  /** Rỗng ⇒ vế điều kiện không bao giờ khớp (sửa lỗi `[].every` của §6.5 cũ) */
  all: readonly CompiledCondition[];
}

export interface PreparedSnapshot {
  flags: ReadonlyMap<string, PreparedEntry>;
  /** Khoá flag đã sắp — thứ tự của `evaluateAll` */
  keys: readonly string[];
  segments: ReadonlyMap<string, PreparedSegment | "broken">;
}

/**
 * Khớp segment trong MỘT lượt đánh giá, có nhớ: bulk OFREP đánh giá mọi flag với
 * cùng context, và nhiều rule trỏ cùng một segment.
 */
export type SegmentMatcher = (segmentId: string) => boolean | "broken";

export function segmentMatcherOf(
  prepared: PreparedSnapshot,
  context: EvalContext,
): SegmentMatcher {
  const memo = new Map<string, boolean | "broken">();
  return (id) => {
    const hit = memo.get(id);
    if (hit !== undefined) return hit;
    const segment = prepared.segments.get(id);
    let result: boolean | "broken";
    if (segment === undefined) {
      result = false; // segment đã xoá ⇒ rule không khớp (§6.5)
    } else if (segment === "broken") {
      result = "broken";
    } else {
      const key = attributeOf(context, "targetingKey");
      // `targetingKey` rỗng = vắng, cùng luật USER_BASED (§6.5)
      result =
        (typeof key === "string" && key !== "" && segment.userIds.has(key)) ||
        (segment.all.length > 0 && segment.all.every((c) => c(context)));
    }
    memo.set(id, result);
    return result;
  };
}

// ------------------------------------------------------------- hình dạng dây

const tombstoneSchema = z.object({
  key: z.string(),
  archived: z.literal(true),
});

const flagEntrySchema = z.object({
  key: z.string(),
  type: z.string(),
  isEnabled: z.boolean(),
  stickinessAttribute: z.string(),
  variants: z.record(z.unknown()),
  defaultVariantKey: z.string(),
  rules: z.array(z.unknown()),
});

const ruleSchema = z.object({
  id: z.string(),
  type: z.enum(RULE_TYPES),
  condition: z.unknown(),
  serve: flagServeWireSchema,
  bucketSalt: z.string(),
});

const segmentSchema = z.object({
  id: z.string(),
  all: z.array(z.unknown()),
  userIds: z.array(z.string()),
});

function matcherOf(
  type: RuleType,
  condition: unknown,
): PreparedRule["matches"] {
  switch (type) {
    case "ALL": {
      const parsed = readConditionSchemas.ALL.safeParse(condition);
      return parsed.success ? () => true : undefined;
    }
    case "USER_BASED": {
      const parsed = readConditionSchemas.USER_BASED.safeParse(condition);
      if (!parsed.success) return undefined;
      const ids = new Set(parsed.data.userIds.map(nfc));
      return (ctx) => {
        const key = attributeOf(ctx, "targetingKey");
        // `targetingKey` vắng/rỗng/không phải chuỗi ⇒ không khớp — tránh
        // `String(undefined) === "undefined"` khớp nhầm một userId tên như vậy
        return typeof key === "string" && key !== "" && ids.has(key);
      };
    }
    case "ATTRIBUTE_BASED": {
      const parsed = readConditionSchemas.ATTRIBUTE_BASED.safeParse(condition);
      if (!parsed.success) return undefined;
      const all = parsed.data.all.map(compileCondition);
      return (ctx) => all.every((c) => c(ctx));
    }
    case "SEGMENT": {
      const parsed = readConditionSchemas.SEGMENT.safeParse(condition);
      if (!parsed.success) return undefined;
      const { segmentId } = parsed.data;
      return (_ctx, segments) => segments(segmentId);
    }
  }
}

function prepareRule(raw: unknown): PreparedRule {
  const parsed = ruleSchema.safeParse(raw);
  if (!parsed.success) {
    const id =
      typeof raw === "object" && raw !== null && "id" in raw
        ? String(raw.id)
        : "";
    return { id, matches: undefined, serve: undefined, bucketSalt: "" };
  }
  const rule = parsed.data;
  let matches: PreparedRule["matches"];
  try {
    matches = matcherOf(rule.type, rule.condition);
  } catch {
    matches = undefined;
  }
  return {
    id: rule.id,
    matches,
    serve: rule.serve,
    bucketSalt: rule.bucketSalt,
  };
}

function prepareEntry(raw: unknown): PreparedEntry | undefined {
  const tomb = tombstoneSchema.safeParse(raw);
  if (tomb.success) return { kind: "tombstone", key: tomb.data.key };

  const parsed = flagEntrySchema.safeParse(raw);
  if (!parsed.success) {
    const key =
      typeof raw === "object" && raw !== null && "key" in raw
        ? raw.key
        : undefined;
    return typeof key === "string" ? { kind: "broken", key } : undefined;
  }
  const f = parsed.data;
  return {
    kind: "flag",
    key: f.key,
    type: f.type,
    isEnabled: f.isEnabled,
    stickinessAttribute: f.stickinessAttribute,
    variants: new Map(Object.entries(f.variants)),
    defaultVariantKey: f.defaultVariantKey,
    rules: f.rules.map(prepareRule),
  };
}

function prepareSegment(
  raw: unknown,
): [string, PreparedSegment | "broken"] | undefined {
  const parsed = segmentSchema.safeParse(raw);
  if (!parsed.success) {
    const id =
      typeof raw === "object" && raw !== null && "id" in raw
        ? raw.id
        : undefined;
    return typeof id === "string" ? [id, "broken"] : undefined;
  }
  const conditions = readSegmentConditionsSchema.safeParse({
    all: parsed.data.all,
    userIds: parsed.data.userIds,
  });
  if (!conditions.success) return [parsed.data.id, "broken"];
  try {
    return [
      parsed.data.id,
      {
        userIds: new Set(conditions.data.userIds.map(nfc)),
        all: conditions.data.all.map(compileCondition),
      },
    ];
  } catch {
    return [parsed.data.id, "broken"];
  }
}

/** Dựng snapshot cho đánh giá. KHÔNG ném, với bất kỳ đầu vào nào (I33) */
export function prepareSnapshot(snapshot: Snapshot): PreparedSnapshot {
  const flags = new Map<string, PreparedEntry>();
  const segments = new Map<string, PreparedSegment | "broken">();
  try {
    const rawFlags: unknown = snapshot.flags;
    if (Array.isArray(rawFlags)) {
      for (const raw of rawFlags as unknown[]) {
        const entry = prepareEntry(raw);
        if (entry !== undefined) flags.set(entry.key, entry);
      }
    }
    const rawSegments: unknown = snapshot.segments;
    if (Array.isArray(rawSegments)) {
      for (const raw of rawSegments as unknown[]) {
        const segment = prepareSegment(raw);
        if (segment !== undefined) segments.set(segment[0], segment[1]);
      }
    }
  } catch {
    // Chỉ tới được với đầu vào không phải dữ liệu JSON (getter ném…) — giữ phần đã dựng
  }
  const keys = [...flags.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return { flags, keys, segments };
}
