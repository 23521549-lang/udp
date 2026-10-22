import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CONDITION_LIMITS,
  PROVIDER,
  SDK_STATS,
  SSE,
  TOTAL_BUCKETS,
} from "@udp/config/constants";
import {
  regexSyntaxIssue,
  STATS_VARIANT,
  type Evaluation,
} from "@udp/shared-types";
import {
  applyDelta,
  bucketOf,
  canonicalJson,
  configHashOf,
  EVALUATOR_SEMANTICS_VERSION,
  evaluate,
  prepareSnapshot,
  type Snapshot,
  type SnapshotFlag,
  type SnapshotRule,
} from "../src/index.js";

/**
 * [v4.11, Plan #47] Vector kiểm tính tương đương giữa các bản hiện thực của lõi đánh giá (§6.8
 * "Bản Python — dùng lại vector test hash/delta dạng JSON").
 *
 * Nguồn sự thật là CHÍNH `@udp/flag-evaluator`: tệp `conformance/vectors.json` là đầu ra của hàm
 * dưới đây, và `tests/conformance.test.ts` dựng lại rồi so với tệp — sửa lõi mà quên sinh lại là
 * đỏ, nên tệp không thể trôi khỏi mã. Bản Python chạy qua ĐÚNG tệp đó: cùng bucket, cùng JSON
 * chuẩn tắc, cùng `config_hash`, cùng kết quả đánh giá và cùng kết cục áp delta — I26 giữa hai
 * ngôn ngữ đúng bằng phép so, không bằng lời hứa.
 *
 * Mọi thứ tất định (PRNG hạt cố định): chạy lại cho ra đúng từng byte.
 *
 * Sinh lại: `pnpm --filter @udp/flag-evaluator conformance`.
 */

/** Mulberry32 — đủ tốt cho dữ liệu test, và tất định trên mọi nền tảng */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/** Chuỗi hiển thị có dấu, NFD của nó, emoji (cặp thay thế UTF-16), và ASCII */
const STRINGS = [
  "user-1",
  "Nguyễn",
  "Nguyễn".normalize("NFD"),
  "Đặng Thị Ánh",
  "😀-emoji",
  "",
  "a:b:c",
  "ẞtraße",
];

/** Kết quả chiếu xuống các trường mọi bản hiện thực phải khớp — `errorMessage` là chữ, không phải hợp đồng */
function visible(e: Evaluation): Record<string, unknown> {
  const out: Record<string, unknown> = { reason: e.reason };
  if (e.value !== undefined) out.value = e.value;
  if (e.variant !== undefined) out.variant = e.variant;
  if (e.errorCode !== undefined) out.errorCode = e.errorCode;
  if (e.ruleId !== undefined) out.ruleId = e.ruleId;
  if (e.archived !== undefined) out.archived = e.archived;
  return out;
}

const baseFlag = (over: Partial<SnapshotFlag> = {}): SnapshotFlag => ({
  key: "f",
  type: "BOOLEAN",
  isEnabled: true,
  stickinessAttribute: "targetingKey",
  variants: { on: true, off: false },
  defaultVariantKey: "off",
  rules: [],
  ...over,
});

const rule = (
  id: string,
  type: SnapshotRule["type"],
  condition: unknown,
  serve: SnapshotRule["serve"] = { kind: "variant", variantKey: "on" },
  priority = 10,
): SnapshotRule => ({
  id,
  type,
  condition,
  serve,
  bucketSalt: `salt-${id}`,
  priority,
});

const attr = (attribute: string, operator: string, value: unknown) => ({
  all: [{ attribute, operator, value }],
});

const split = (on: number): SnapshotRule["serve"] => ({
  kind: "distribution",
  weights: [
    { variantKey: "on", weight: on },
    { variantKey: "off", weight: TOTAL_BUCKETS - on },
  ],
});

const snapshotOf = (
  flags: Snapshot["flags"],
  segments: Snapshot["segments"] = [],
  trackedFlags: string[] = [],
): Snapshot => ({ flags, segments, trackedFlags });

interface EvalCase {
  name: string;
  snapshot: Snapshot;
  flagKey: string;
  context: Record<string, unknown>;
  expectedType?: string;
}

/** Ca viết tay: mỗi toán tử, mỗi nhánh của thứ tự đánh giá, mỗi ca hỏng */
function curatedCases(): EvalCase[] {
  const one = (
    name: string,
    r: SnapshotRule,
    context: Record<string, unknown>,
    over: Partial<SnapshotFlag> = {},
  ): EvalCase => ({
    name,
    snapshot: snapshotOf([baseFlag({ rules: [r], ...over })]),
    flagKey: "f",
    context,
  });
  const ops: [string, unknown, Record<string, unknown>][] = [
    ["eq", "VN", { country: "VN" }],
    ["eq", "VN", { country: "US" }],
    ["eq", 5, { n: "5" }],
    ["eq", 5, { n: 5 }],
    ["eq", true, { beta: true }],
    ["neq", "VN", { country: "US" }],
    ["neq", "VN", {}],
    ["neq", 5, { n: "5" }],
    ["in", ["VN", "TH"], { country: "TH" }],
    ["in", ["Nguyễn"], { name: "Nguyễn".normalize("NFD") }],
    ["nin", ["VN"], { country: "US" }],
    ["nin", ["VN"], { country: 5 }],
    ["gt", 10, { n: 11 }],
    ["gt", 10, { n: 10 }],
    ["gte", 0.5, { score: 0.5 }],
    ["lt", -1, { n: -2 }],
    ["lte", 3, { n: "3" }],
    ["contains", "ễ", { name: "Nguyễn".normalize("NFD") }],
    ["startsWith", "ab", { s: "abc" }],
    ["endsWith", "yz", { s: "xyz" }],
    ["semverGt", "1.2.3", { v: "1.10.0" }],
    ["semverGt", "1.2.3", { v: "1.2.3-rc.1" }],
    ["semverLt", "2.0.0-alpha.10", { v: "2.0.0-alpha.9" }],
    ["semverLt", "1.0.0", { v: "not-a-version" }],
    ["regex", "^[a-z]+$", { s: "abc" }],
    ["regex", "^[a-z]+$", { s: "abc\n" }],
    ["regex", "\\d{3}", { s: "a١٢٣b" }],
    ["regex", "\\d{3}", { s: "a123b" }],
    ["regex", "^\\w+@\\w+\\.vn$", { s: "an@hq.vn" }],
    ["regex", "^\\w+$", { s: "Nguyễn" }],
    ["regex", "^\\s+x", { s: " x" }],
    ["regex", "^a.c$", { s: "a\rc" }],
    ["regex", "^(?<y>\\d{4})-\\d{2}$", { s: "2026-09" }],
    ["regex", "\\bvn\\b", { s: "hq.vn" }],
    ["regex", "[\\d\\s]+", { s: "x" }],
    ["regex", "^.{3}$", { s: "😀ab" }],
    ["regex", "a", { s: "x".repeat(CONDITION_LIMITS.regexInputMax) + "a" }],
  ];
  const cases = ops.map(([op, value, ctx], i) =>
    one(
      `op-${op}-${String(i)}`,
      rule(
        `r${String(i)}`,
        "ATTRIBUTE_BASED",
        attr(Object.keys(ctx)[0] ?? "k", op, value),
      ),
      ctx,
    ),
  );
  return [
    ...cases,
    one("user-based-hit", rule("u", "USER_BASED", { userIds: ["Nguyễn"] }), {
      targetingKey: "Nguyễn".normalize("NFD"),
    }),
    one("user-based-miss", rule("u", "USER_BASED", { userIds: ["x"] }), {
      targetingKey: "y",
    }),
    one("all-rule", rule("a", "ALL", {}), {}),
    one("disabled", rule("a", "ALL", {}), {}, { isEnabled: false }),
    one(
      "no-sticky-skips-distribution",
      rule("d", "ALL", {}, split(50_000)),
      {},
    ),
    one("sticky-number", rule("d", "ALL", {}, split(50_000)), {
      targetingKey: 42,
    }),
    one("sticky-bool", rule("d", "ALL", {}, split(50_000)), {
      targetingKey: true,
    }),
    one(
      "stickiness-attribute",
      rule("d", "ALL", {}, split(30_000)),
      { targetingKey: "t", accountId: "acc-9" },
      { stickinessAttribute: "accountId" },
    ),
    one(
      "orphan-variant",
      rule("o", "ALL", {}, { kind: "variant", variantKey: "ghost" }),
      {},
    ),
    one("broken-rule", rule("b", "ATTRIBUTE_BASED", { all: "nope" }), {}),
    one(
      "orphan-default",
      rule("m", "USER_BASED", { userIds: ["z"] }),
      {},
      { defaultVariantKey: "ghost" },
    ),
    {
      name: "type-mismatch",
      snapshot: snapshotOf([baseFlag()]),
      flagKey: "f",
      context: {},
      expectedType: "STRING",
    },
    {
      name: "not-found",
      snapshot: snapshotOf([baseFlag()]),
      flagKey: "nope",
      context: {},
    },
    {
      name: "tombstone",
      snapshot: snapshotOf([{ key: "f", archived: true }]),
      flagKey: "f",
      context: {},
    },
    {
      name: "segment-by-user",
      snapshot: snapshotOf(
        [
          baseFlag({
            rules: [
              rule("s", "SEGMENT", {
                segmentId: "00000000-0000-4000-8000-000000000001",
              }),
            ],
          }),
        ],
        [
          {
            id: "00000000-0000-4000-8000-000000000001",
            all: [],
            userIds: ["u9"],
          },
        ],
      ),
      flagKey: "f",
      context: { targetingKey: "u9" },
    },
    {
      name: "segment-by-attribute",
      snapshot: snapshotOf(
        [
          baseFlag({
            rules: [
              rule("s", "SEGMENT", {
                segmentId: "00000000-0000-4000-8000-000000000002",
              }),
            ],
          }),
        ],
        [
          {
            id: "00000000-0000-4000-8000-000000000002",
            all: [{ attribute: "plan", operator: "eq", value: "pro" }],
            userIds: [],
          },
        ],
      ),
      flagKey: "f",
      context: { targetingKey: "x", plan: "pro" },
    },
    {
      name: "segment-missing",
      snapshot: snapshotOf([
        baseFlag({
          rules: [
            rule("s", "SEGMENT", {
              segmentId: "00000000-0000-4000-8000-000000000003",
            }),
          ],
        }),
      ]),
      flagKey: "f",
      context: {},
    },
    {
      name: "segment-broken",
      snapshot: snapshotOf(
        [
          baseFlag({
            rules: [
              rule("s", "SEGMENT", {
                segmentId: "00000000-0000-4000-8000-000000000004",
              }),
            ],
          }),
        ],
        [
          {
            id: "00000000-0000-4000-8000-000000000004",
            all: [{ attribute: "x", operator: "semverGt", value: "bad" }],
            userIds: [],
          },
        ],
      ),
      flagKey: "f",
      context: {},
    },
    {
      name: "rule-order-priority",
      snapshot: snapshotOf([
        baseFlag({
          rules: [
            rule("late", "ALL", {}, { kind: "variant", variantKey: "off" }, 20),
            rule("early", "ALL", {}, { kind: "variant", variantKey: "on" }, 10),
          ],
        }),
      ]),
      flagKey: "f",
      context: {},
    },
    {
      name: "proto-attribute",
      snapshot: snapshotOf([
        baseFlag({
          rules: [rule("p", "ATTRIBUTE_BASED", attr("toString", "eq", "x"))],
        }),
      ]),
      flagKey: "f",
      context: {},
    },
    {
      name: "json-flag",
      snapshot: snapshotOf([
        baseFlag({
          type: "JSON",
          variants: { a: { k: [1, 2.5, "ễ"] }, b: null },
          defaultVariantKey: "a",
        }),
      ]),
      flagKey: "f",
      context: {},
      expectedType: "JSON",
    },
  ];
}

/** Ca sinh ngẫu nhiên: phân phối nhiều variant, nhiều người dùng — phủ phép cộng dồn bucket */
function generatedCases(random: () => number): EvalCase[] {
  const cases: EvalCase[] = [];
  for (let i = 0; i < 40; i += 1) {
    const cut1 = Math.floor(random() * TOTAL_BUCKETS);
    const cut2 = cut1 + Math.floor(random() * (TOTAL_BUCKETS - cut1));
    const serve: SnapshotRule["serve"] = {
      kind: "distribution",
      weights: [
        { variantKey: "a", weight: cut1 },
        { variantKey: "b", weight: cut2 - cut1 },
        { variantKey: "c", weight: TOTAL_BUCKETS - cut2 },
      ],
    };
    const user = `${STRINGS[i % STRINGS.length] ?? ""}-${String(Math.floor(random() * 1e6))}`;
    cases.push({
      name: `gen-${String(i)}`,
      snapshot: snapshotOf([
        baseFlag({
          key: `g${String(i)}`,
          type: "STRING",
          variants: { a: "A", b: "B", c: "C" },
          defaultVariantKey: "a",
          rules: [rule(`g${String(i)}`, "ALL", {}, serve)],
        }),
      ]),
      flagKey: `g${String(i)}`,
      context: { targetingKey: user },
    });
  }
  return cases;
}

function bucketVectors(random: () => number) {
  const out: {
    stickyValue: string;
    flagKey: string;
    bucketSalt: string;
    bucket: number;
  }[] = [];
  for (const s of STRINGS) {
    for (let i = 0; i < 4; i += 1) {
      const input = {
        stickyValue: `${s}${String(i)}`,
        flagKey: i % 2 === 0 ? "checkout-v2" : "Đặt-hàng",
        bucketSalt: `salt-${String(Math.floor(random() * 1e9))}`,
      };
      out.push({ ...input, bucket: bucketOf(input) });
    }
  }
  return out;
}

function canonicalVectors() {
  const values: unknown[] = [
    { b: 1, a: [true, null, "x"] },
    { "￿": 1, "\u{1F600}": 2, é: 3, e: 4 },
    {
      n: [
        0.1,
        0.30000000000000004,
        1e21,
        1e-7,
        123.456,
        -0.5,
        5e-324,
        2 ** 53,
        1.5e300,
      ],
    },
    {
      s: "Nguyễn".normalize("NFD"),
      ctrl: 'a\u0001b\n\t"\\/',
      sep: String.fromCharCode(0x2028),
    },
    { nested: { z: { y: { x: [] } } }, empty: {} },
  ];
  return values.map((value) => ({ value, json: canonicalJson(value) }));
}

function configHashVectors(cases: EvalCase[]) {
  return cases.slice(0, 12).map((c) => ({
    snapshot: {
      ...c.snapshot,
      trackedFlags: ["z-flag", "a-flag"],
    },
    hash: configHashOf({ ...c.snapshot, trackedFlags: ["z-flag", "a-flag"] }),
  }));
}

function deltaVectors() {
  const s0 = snapshotOf(
    [baseFlag({ key: "x" }), baseFlag({ key: "y" })],
    [],
    ["x"],
  );
  const s1 = snapshotOf(
    [baseFlag({ key: "x", isEnabled: false }), baseFlag({ key: "y" })],
    [],
    ["x"],
  );
  const good = {
    fromVersion: 3,
    toVersion: 4,
    configHash: configHashOf(s1),
    changes: [
      {
        configVersion: 4,
        kind: "flag",
        flag: baseFlag({ key: "x", isEnabled: false }),
      },
    ],
  };
  const deltas: { name: string; delta: typeof good }[] = [
    { name: "applied", delta: good },
    { name: "stale-ignored", delta: { ...good, fromVersion: 2, toVersion: 3 } },
    { name: "gap", delta: { ...good, fromVersion: 1, toVersion: 5 } },
    { name: "hash-mismatch", delta: { ...good, configHash: "0".repeat(64) } },
    { name: "no-baseline", delta: { ...good, configHash: "" } },
    {
      name: "tracked-and-absent",
      delta: {
        fromVersion: 3,
        toVersion: 5,
        configHash: configHashOf(snapshotOf([baseFlag({ key: "x" })], [], [])),
        changes: [
          { configVersion: 4, kind: "flagAbsent", key: "y" } as never,
          { configVersion: 5, kind: "trackedFlags", trackedFlags: [] } as never,
        ],
      },
    },
  ];
  return deltas.map(({ name, delta }) => {
    const outcome = applyDelta(
      { snapshot: s0, configVersion: 3 },
      delta as never,
    );
    return {
      name,
      cache: { snapshot: s0, configVersion: 3 },
      delta,
      outcome:
        outcome.kind === "applied"
          ? {
              kind: "applied",
              configVersion: outcome.configVersion,
              hash: configHashOf(outcome.snapshot),
            }
          : outcome.kind === "resync"
            ? { kind: "resync", reason: outcome.reason }
            : { kind: "ignored" },
    };
  });
}

/** Một ký tự theo code point — số thay vì escape, để mã nguồn không chứa ký tự vô hình */
const chr = (...cps: number[]): string => String.fromCodePoint(...cps);
/** `\` + phần còn lại — pattern ở vector đúng NGUYÊN VĂN người dùng gõ */
const esc = (body: string): string => `\\${body}`;

/** Regex viết tay: mỗi cấu trúc mà bản dịch sang `re` của Python phải xử lý riêng */
const REGEX_CURATED = [
  esc("cJ"),
  esc("uD83D") + esc("uDE00"),
  esc("u{1F600}"),
  esc("uD83D"),
  esc("x41"),
  esc("u0041"),
  esc("0"),
  esc("/"),
  "(?<a$>x)",
  "[^]",
  "[]",
  `[${esc("S")}]`,
  `[^${esc("S")}]`,
  `[a${esc("S")}]`,
  `[^a${esc("S")}]`,
  `[${esc("s")}${esc("S")}]`,
  `[${esc("D")}${esc("W")}]`,
  "[[]",
  `[${esc("b")}]`,
  "a{99999999999}",
  `^${esc("s")}$`,
  esc("S"),
  "[--a]",
  "[a-]",
  "^$",
  "a|",
  "(?:)",
  "a{2}?",
  `${esc("b")}a`,
  `a${esc("B")}`,
  // Ngoài ngữ pháp khả chuyển (D-P35) hoặc không hợp lệ với cờ `u`: hai bên cùng bác
  `${esc("p")}{L}`,
  "(?i:a)",
  `(?<${chr(0xe9)}>a)`,
  "(?<a>x)|(?<a>y)",
  "a{",
  esc("q"),
  "x{2,1}",
  `[${esc("d")}-z]`,
  `[${esc("1")}]`,
];

/** Mảnh ghép pattern ngẫu nhiên — đủ loại để bộ sinh ra cả pattern hợp lệ lẫn không */
const REGEX_TOKENS = [
  "a",
  "b",
  chr(0xe9),
  chr(0x1f600),
  "0",
  "_",
  " ",
  "-",
  ".",
  "^",
  "$",
  "|",
  "*",
  "+",
  "?",
  "*?",
  "{2}",
  "{1,3}",
  "{2,}",
  "{3,1}",
  "{",
  "}",
  "(",
  ")",
  "(?:",
  "(?<g>",
  "(?=",
  "(?i:",
  "[",
  "]",
  "[^",
  "a-z",
  "z-a",
  esc("d"),
  esc("D"),
  esc("w"),
  esc("W"),
  esc("s"),
  esc("S"),
  esc("b"),
  esc("B"),
  esc("n"),
  esc("t"),
  esc("cJ"),
  esc("x41"),
  esc("u0041"),
  esc("u{1F600}"),
  esc("uD83D") + esc("uDE00"),
  esc("0"),
  esc("-"),
  esc("."),
  esc("/"),
  esc("q"),
  `${esc("p")}{L}`,
  `${esc("k")}<g>`,
  esc("1"),
];

/** Chuỗi đem so: chữ số không phải ASCII, khoảng trắng ECMAScript và KHÔNG phải, NFD, emoji, surrogate lẻ */
const REGEX_INPUTS = [
  "",
  "a",
  "ab",
  "A",
  "_",
  "0",
  "9",
  chr(0x661),
  " ",
  "\t",
  "\n",
  "\r",
  chr(0x0b),
  chr(0xa0),
  chr(0x85),
  chr(0x1c),
  chr(0x2028),
  chr(0xfeff),
  chr(0x200b),
  chr(0xe9),
  `e${chr(0x301)}`,
  chr(0x1f600),
  String.fromCharCode(0xd83d),
  "x-y",
  "-",
  "[",
  "a.b",
  "g",
  "zz",
  "a1_ b",
];

/**
 * Regex: pattern viết tay + 600 pattern ghép ngẫu nhiên, mỗi pattern 6 chuỗi, đi qua lõi đánh giá
 * THẬT (NFC, trần độ dài, `new RegExp(…, "u")`). `rejected` là kết luận của `regexSyntaxIssue`;
 * kết cục `broken` là rule hỏng (ERROR) — bản Python phải bác ĐÚNG cùng tập pattern.
 */
function regexVectors(random: () => number) {
  const pick = <T>(items: readonly T[]): T =>
    items[Math.floor(random() * items.length)] as T;
  const patterns = [...REGEX_CURATED];
  for (let i = 0; i < 600; i += 1) {
    const size = 1 + Math.floor(random() * 6);
    patterns.push(
      Array.from({ length: size }, () => pick(REGEX_TOKENS)).join(""),
    );
  }
  return patterns.map((pattern) => {
    const prepared = prepareSnapshot(
      snapshotOf([
        baseFlag({
          rules: [rule("rx", "ATTRIBUTE_BASED", attr("s", "regex", pattern))],
        }),
      ]),
    );
    const inputs = Array.from(
      { length: 6 },
      () => pick(REGEX_INPUTS) + (random() < 0.5 ? pick(REGEX_INPUTS) : ""),
    );
    return {
      pattern,
      rejected: regexSyntaxIssue(pattern) !== undefined,
      cases: inputs.map((input) => {
        const { reason } = evaluate(prepared, "f", { s: input });
        return [
          input,
          reason === "ERROR" ? "broken" : reason === "TARGETING_MATCH",
        ];
      }),
    };
  });
}

export function buildConformanceVectors() {
  const random = prng(0x5eed_2026);
  const cases = [...curatedCases(), ...generatedCases(random)];
  return {
    version: 1,
    semanticsVersion: EVALUATOR_SEMANTICS_VERSION,
    totalBuckets: TOTAL_BUCKETS,
    regexInputMax: CONDITION_LIMITS.regexInputMax,
    bucket: bucketVectors(random),
    canonicalJson: canonicalVectors(),
    configHash: configHashVectors(cases),
    evaluate: cases.map((c) => ({
      ...c,
      evaluation: visible(
        evaluate(prepareSnapshot(c.snapshot), c.flagKey, c.context, {
          ...(c.expectedType === undefined
            ? {}
            : { expectedType: c.expectedType }),
        }),
      ),
    })),
    delta: deltaVectors(),
    regex: regexVectors(prng(0x5eed_2027)),
    defaults: defaultsOfProviders(),
  };
}

/**
 * Hằng số mà MỌI provider phải dùng giống hệt (§6.8 "tuỳ chọn, giá trị mặc định giống
 * hệt") — bản Python so từng bảng với phần này thay vì chép tay số của bản Node.
 */
function defaultsOfProviders() {
  const { report } = SDK_STATS;
  return {
    sse: {
      heartbeatMs: SSE.heartbeatMs,
      fallbackAfterFailures: SSE.fallbackAfterFailures,
      pollingFallbackMs: SSE.pollingFallbackMs,
    },
    provider: { ...PROVIDER },
    sdkStatsReport: {
      intervalMs: report.intervalMs,
      jitterRatio: report.jitterRatio,
      requestTimeoutMs: report.requestTimeoutMs,
      shutdownFlushTimeoutMs: report.shutdownFlushTimeoutMs,
      maxEntriesPerReport: report.maxEntriesPerReport,
      maxCountPerEntry: report.maxCountPerEntry,
      maxPendingEntries: report.maxPendingEntries,
    },
    statsVariant: { ...STATS_VARIANT },
  };
}

export const VECTORS_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "conformance",
  "vectors.json",
);

if (process.argv.includes("--write")) {
  writeFileSync(
    VECTORS_PATH,
    `${JSON.stringify(buildConformanceVectors(), null, 2)}\n`,
    "utf8",
  );
  console.log(`đã ghi ${VECTORS_PATH}`);
}
