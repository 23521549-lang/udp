import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { IN_PROCESS, writeResult } from "@udp/experiments";
import { ORACLE_CODES } from "../tests/oracle/capability-oracle.js";

/**
 * **E8** (§14.1) [Plan #42] — mutation testing lên capability validator, bộ giết là differential
 * test đối chiếu ORACLE ĐỘC LẬP (`tests/oracle/`, cổng `oracle-independence` của design-lint).
 *
 *   pnpm --filter @udp/core-backend e8 [--note "…"]
 *
 * Mỗi mutant là MỘT thay đổi viết tay trên `capability.resolver.ts`, nhắm một nhánh của §5.3: đảo
 * điều kiện, lệch biên, bỏ một mã lỗi, bỏ một chiều kiểm. Với từng mutant: áp lên tệp, chạy khối
 * differential (`-t differential`); sống thì chạy cả bộ test của resolver. Hết hạn (mutant làm vòng
 * lặp không dừng) tính là BỊ GIẾT — bộ test không xanh. Tệp LUÔN được khôi phục (kể cả Ctrl+C), và
 * sha256 cuối phải trùng sha256 đầu, nếu không script thoát với lỗi.
 *
 * Chỉ số của §14.1: mutant sống sót (kỳ vọng 0) và số mã kết quả oracle sinh được (kỳ vọng 7/7 —
 * `oracle-codes.test.ts` là cổng của nó).
 */

const { values } = parseArgs({ options: { note: { type: "string" } } });
const here = dirname(fileURLToPath(import.meta.url));
const PACKAGE = resolve(here, "..");
const TARGET = join(PACKAGE, "src/modules/capability/capability.resolver.ts");
const SUITE = "tests/capability-resolver.test.ts";
const RUN_TIMEOUT_MS = 180_000;

interface Mutant {
  id: string;
  what: string;
  from: string;
  to: string;
}

const MUTANTS: readonly Mutant[] = [
  {
    id: "exclusive-off-by-one",
    what: "exclusive chỉ bắt từ ba provider",
    from: "if (ps.length > 1 && ps.some((p) => p.exclusive)) {",
    to: "if (ps.length > 2 && ps.some((p) => p.exclusive)) {",
  },
  {
    id: "exclusive-every",
    what: "exclusive chỉ khi MỌI provider exclusive",
    from: "if (ps.length > 1 && ps.some((p) => p.exclusive)) {",
    to: "if (ps.length > 1 && ps.every((p) => p.exclusive)) {",
  },
  {
    id: "conflicts-one-way",
    what: "conflicts chỉ kiểm một chiều",
    from: 'if (present.has(c)) return failure("CONFLICT", adapterKey(a), [c]);',
    to: 'if (present.has(c) && c > adapterKey(a)) return failure("CONFLICT", adapterKey(a), [c]);',
  },
  {
    id: "anyof-skipped",
    what: "anyOf không thoả mà vẫn qua",
    from: "if (ok) continue;",
    to: "if (ok || isAnyOf(r)) continue;",
  },
  {
    id: "requires-ignores-constraint",
    what: "requires bỏ qua ràng buộc semver",
    from: 'satisfies(p.version, x.constraint ?? "*"),',
    to: 'satisfies(p.version, "*"),',
  },
  {
    id: "missing-vs-mismatch-swapped",
    what: "đảo MISSING_CAPABILITY và VERSION_MISMATCH",
    from: 'provided.has(only.id) ? "VERSION_MISMATCH" : "MISSING_CAPABILITY",',
    to: 'provided.has(only.id) ? "MISSING_CAPABILITY" : "VERSION_MISMATCH",',
  },
  {
    id: "recommends-inverted",
    what: "cảnh báo recommends khi ĐÃ có",
    from: "if (!provided.has(c)) {",
    to: "if (provided.has(c)) {",
  },
  {
    id: "no-consumer-still-chooses",
    what: "chọn provider cả khi không ai tiêu thụ (D-10)",
    from: "if (consumers.length === 0) continue;",
    to: "if (consumers.length < 0) continue;",
  },
  {
    id: "preference-unchecked",
    what: "preference không thoả semver vẫn được chọn (D-4')",
    from: "if (!satisfying.some((x) => x.by === pref.providerToolId)) {",
    to: "if (satisfying.length < 0) {",
  },
  {
    id: "no-satisfying-silent",
    what: "không provider nào thoả mà không báo",
    from: "if (satisfying.length === 0) {",
    to: "if (satisfying.length < 0) {",
  },
  {
    id: "ambiguous-picks-first",
    what: "nhiều provider thoả ⇒ chọn đại cái đầu thay vì AMBIGUOUS_PROVIDER",
    from: "if (satisfying.length === 1 && single !== undefined) {",
    to: "if (single !== undefined) {",
  },
  {
    id: "verify-chosen-dropped",
    what: "bỏ bước 6 verifyChosen",
    from: 'if (!satisfies(version, r.constraint ?? "*")) {',
    to: "if (version.length < 0) {",
  },
  {
    id: "self-loop-is-cycle",
    what: "adapter tự thoả bị coi là chu trình",
    from: "if (provider === undefined || provider === self) continue;",
    to: "if (provider === undefined) continue;",
  },
  {
    id: "cycle-never-detected",
    what: "không bao giờ phát hiện chu trình (vòng lặp không dừng)",
    from: "if (ready.length === 0) return null;",
    to: "if (ready.length < 0) return null;",
  },
  {
    id: "version-not-semver-accepted",
    what: "version provides không phải semver vẫn nhận",
    from: "if (valid(p.version) === null) {",
    to: "if (p.version.length < 0) {",
  },
  {
    id: "anyof-single-branch-accepted",
    what: "anyOf một nhánh vẫn nhận",
    from: "if (isAnyOf(r) && alts.length < 2) {",
    to: "if (isAnyOf(r) && alts.length < 1) {",
  },
  {
    id: "bad-range-accepted",
    what: "constraint không phải khoảng semver vẫn nhận",
    from: "if (x.constraint !== undefined && validRange(x.constraint) === null) {",
    to: "if (x.constraint !== undefined && x.constraint.length < 0) {",
  },
];

const require = createRequire(import.meta.url);
const VITEST = join(
  dirname(require.resolve("vitest/package.json")),
  "vitest.mjs",
);

/** `true` = bộ test ĐỎ (hay treo tới hạn) ⇒ mutant bị giết */
function killed(filter: string | null): {
  killed: boolean;
  timedOut: boolean;
  tail: string;
} {
  const args = [
    VITEST,
    "run",
    SUITE,
    ...(filter === null ? [] : ["-t", filter]),
  ];
  const run = spawnSync(process.execPath, args, {
    cwd: PACKAGE,
    timeout: RUN_TIMEOUT_MS,
    encoding: "utf8",
  });
  const timedOut = run.error !== undefined || run.signal !== null;
  return {
    killed: timedOut || run.status !== 0,
    timedOut,
    tail: `${run.stdout}${run.stderr}`.slice(-2_000),
  };
}

const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const original = readFileSync(TARGET, "utf8");
const originalSha = sha(original);
const restore = () => {
  writeFileSync(TARGET, original);
};
process.on("SIGINT", () => {
  restore();
  process.exit(130);
});

// Đối chứng: bộ test phải XANH trên mã gốc, nếu không mọi mutant "bị giết" là giả
const baseline = killed(null);
if (baseline.killed) {
  console.error(baseline.tail);
  console.error("bộ test resolver đỏ trên mã gốc — dừng, không đo gì");
  process.exit(1);
}

const results: {
  id: string;
  what: string;
  killedByDifferential: boolean;
  killedBySuite: boolean;
  timedOut: boolean;
}[] = [];
try {
  for (const m of MUTANTS) {
    const occurrences = original.split(m.from).length - 1;
    if (occurrences !== 1) {
      throw new Error(
        `mutant ${m.id}: chuỗi gốc xuất hiện ${String(occurrences)} lần`,
      );
    }
    writeFileSync(TARGET, original.replace(m.from, m.to));
    const differential = killed("differential");
    const suite = differential.killed ? differential : killed(null);
    results.push({
      id: m.id,
      what: m.what,
      killedByDifferential: differential.killed,
      killedBySuite: suite.killed,
      timedOut: differential.timedOut || suite.timedOut,
    });
    console.log(
      `${m.id}: ${differential.killed ? "giết (differential)" : suite.killed ? "giết (bộ test)" : "SỐNG"}`,
    );
    restore();
  }
} finally {
  restore();
}
if (sha(readFileSync(TARGET, "utf8")) !== originalSha) {
  console.error("tệp validator KHÔNG trở về như cũ — kiểm lại bằng git diff");
  process.exit(1);
}

const survivors = results.filter((r) => !r.killedBySuite).map((r) => r.id);
const data = {
  target: "services/core-backend/src/modules/capability/capability.resolver.ts",
  suite: SUITE,
  mutants: results.length,
  killedByDifferential: results.filter((r) => r.killedByDifferential).length,
  killedBySuite: results.filter((r) => r.killedBySuite).length,
  survivors,
  oracleCodes: ORACLE_CODES.length,
  results,
};
console.log(
  `mutant bị giết: ${String(data.killedBySuite)}/${String(data.mutants)} (differential riêng: ${String(data.killedByDifferential)}); sống: ${survivors.join(", ") || "không"}`,
);
console.log(`đã ghi ${writeResult("E8", IN_PROCESS, data, values.note)}`);
