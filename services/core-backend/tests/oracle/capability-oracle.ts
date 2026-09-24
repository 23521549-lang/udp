import {
  isAnyOf,
  type CapabilityDeclaration,
  type CapabilityId,
  type CapabilityRequirement,
} from "@udp/shared-types";

/**
 * [v4.10] ORACLE của bộ chọn provider — hiện thực THAM CHIẾU, viết từ TÀI LIỆU.
 *
 * Nó không phải một bản sao của resolver, và nó **không được** import bất cứ gì từ
 * `src/modules/capability/**`. Một phép kiểm cấu trúc trong `design-lint` cưỡng chế điều
 * đó, và một phép kiểm `git log` cưỡng chế rằng tệp này được commit **trước** resolver.
 *
 * Vì sao hai chốt đó cần thiết, nói thẳng: một oracle viết SAU khi đã có hiện thực gần
 * như chắc chắn mang cùng những lỗi của hiện thực, vì người viết đọc mã trước rồi mới
 * viết. Lúc đó differential test trở thành một phép kiểm "hai bản chép giống nhau" —
 * xanh, tốn thời gian, và không phát hiện được gì. Còn nếu oracle được phép import
 * resolver thì nó không còn độc lập ở tầng mã, dù người viết có kỷ luật đến đâu.
 *
 * **Nó ưu tiên RÕ RÀNG hơn nhanh.** Oracle là thứ dùng để phán xử, nên nó phải đọc được
 * cạnh tài liệu từng bước; hiệu năng của nó không phải vấn đề vì nó chỉ chạy trong test.
 * Nguồn: §5.3 của `docs/UDP_design.md` (pseudo-code `validateAndOrder` sau bản sửa
 * v4.10) cộng thứ tự ưu tiên tường minh của SPEC §2.8.
 *
 * **Bảy mã kết quả** mà nó phải sinh được — sáu lỗi cộng một cảnh báo:
 * `CONFLICT`, `MISSING_CAPABILITY`, `MISSING_ANY_OF`, `VERSION_MISMATCH`,
 * `AMBIGUOUS_PROVIDER`, `CYCLIC_DEPENDENCY`, `RECOMMENDED_MISSING`.
 */

export type OracleErrorCode =
  | "MISSING_CAPABILITY"
  | "MISSING_ANY_OF"
  | "CONFLICT"
  | "VERSION_MISMATCH"
  | "AMBIGUOUS_PROVIDER"
  | "CYCLIC_DEPENDENCY";

export type OracleWarningCode = "RECOMMENDED_MISSING";

/** Bảy mã kết quả của §5.3, dưới dạng dữ liệu để meta-test đếm được */
export const ORACLE_CODES: readonly (OracleErrorCode | OracleWarningCode)[] = [
  "MISSING_CAPABILITY",
  "MISSING_ANY_OF",
  "CONFLICT",
  "VERSION_MISMATCH",
  "AMBIGUOUS_PROVIDER",
  "CYCLIC_DEPENDENCY",
  "RECOMMENDED_MISSING",
];

/** Một adapter dưới dạng dữ liệu thuần — oracle không biết gì về registry thật */
export interface OracleAdapter {
  domainType: string;
  toolId: string;
  capabilities: CapabilityDeclaration;
}

export interface OraclePreference {
  capabilityId: CapabilityId;
  /** `"<domainType>:<toolId>"` */
  providerToolId: string;
}

export interface OracleError {
  code: OracleErrorCode;
  /** Chủ thể của lỗi: khoá adapter, hay `CapabilityId` — theo đúng §5.3 */
  subject: string;
  /** Danh sách kèm theo (candidates của `AMBIGUOUS_PROVIDER`, nhánh của `MISSING_ANY_OF`) */
  detail: string[];
}

export interface OracleWarning {
  code: OracleWarningCode;
  subject: string;
  detail: string[];
}

export interface OracleResult {
  valid: boolean;
  errors: OracleError[];
  warnings: OracleWarning[];
  /** `chosen` CÓ THỂ thiếu khoá — xem D-10 */
  chosen: Record<string, string>;
  /** Thứ tự deploy theo bậc; mỗi bậc chạy song song được */
  order: string[][] | null;
}

/**
 * Hàng preference MỒ CÔI — lỗi khởi động, không phải một mã lỗi mới.
 *
 * §5.3 chọn đường này có chủ đích: thêm một mã lỗi là đổi danh mục lỗi của cả hệ thống,
 * còn bỏ im lặng lựa chọn của người dùng thì chính là lỗi D-4' đang được sửa.
 */
export class OrphanPreferenceError extends Error {
  readonly code = "ORPHAN_PREFERENCE";
  constructor(
    readonly capabilityId: CapabilityId,
    readonly providerToolId: string,
  ) {
    super(
      `hàng preference mồ côi: ${capabilityId} trỏ tới ${providerToolId} ` +
        `không có trong tổ hợp đã chọn`,
    );
    this.name = "OrphanPreferenceError";
  }
}

export const keyOf = (a: OracleAdapter): string =>
  `${a.domainType}:${a.toolId}`;

/**
 * So semver theo cách CỐ Ý ĐƠN GIẢN, và nói rõ nó phủ tới đâu.
 *
 * Oracle **không** dùng thư viện semver: nếu cả oracle và resolver dùng cùng một thư viện
 * thì differential test không kiểm được chính phần so version — hai bên sai giống nhau khi
 * thư viện hiểu một dạng khác với tài liệu. Viết tay ở đây là để hai hiện thực có hai
 * đường suy luận độc lập.
 *
 * **BẤT ĐỐI XỨNG quan trọng, và nó là chỗ bản đầu của hàm này sai:** `version` của một
 * provider phải ĐẦY ĐỦ `x.y.z` (kiểu `CapabilityProvision` nói thế, và khai sai thì service
 * không khởi động), còn `constraint` thì ĐƯỢC thiếu thành phần — `"^2"` là dạng chính
 * §5.3 dùng trong ví dụ Flagger. Bản đầu đòi cả hai đều `x.y.z` nên nó ném ngay ở ô
 * `VERSION_MISMATCH` của chính tài liệu.
 *
 * **Phủ:** `*`; `x.y.z` chính xác; `^` với 1–3 thành phần; `~` với đúng 3 thành phần;
 * `>=`, `>`, `<=`, `<` với 1–3 thành phần.
 *
 * **KHÔNG phủ** — và NÉM chứ không đoán: khoảng kép (`>=1 <2`), `||`, prerelease
 * (`1.0.0-rc1`), và `~` thiếu thành phần. Cái cuối bị loại có chủ đích: npm hiểu `~2` là
 * `>=2.0.0 <3.0.0` (khoá major) nhưng `~2.3` là `>=2.3.0 <2.4.0` (khoá minor), tức ý nghĩa
 * của `~` ĐỔI theo số thành phần. Một oracle đoán chỗ đó là một oracle âm thầm đồng ý
 * với một resolver sai ở đúng trường hợp khó nhất.
 */
type Triple = [number, number, number];

function parseVersion(v: string): Triple {
  const parts = v.trim().split(".");
  if (parts.length !== 3) {
    throw new Error(`oracle: version phải là x.y.z, thấy "${v}"`);
  }
  return parseParts(parts, v);
}

/** Constraint được thiếu thành phần; phần thiếu đệm 0. Trả kèm SỐ thành phần đã nêu */
function parseConstraintTriple(v: string): { triple: Triple; given: number } {
  const parts = v.trim().split(".");
  if (parts.length < 1 || parts.length > 3) {
    throw new Error(`oracle: dạng constraint không phủ: "${v}"`);
  }
  const padded = [...parts, "0", "0"].slice(0, 3);
  return { triple: parseParts(padded, v), given: parts.length };
}

function parseParts(parts: readonly string[], original: string): Triple {
  const nums = parts.map((p) => {
    if (!/^\d+$/.test(p.trim())) {
      throw new Error(`oracle: dạng constraint không phủ: "${original}"`);
    }
    return Number(p);
  });
  return [nums[0] as number, nums[1] as number, nums[2] as number];
}

function cmp(a: Triple, b: Triple): number {
  for (let i = 0; i < 3; i += 1) {
    const x = a[i] as number;
    const y = b[i] as number;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

export function oracleSatisfies(version: string, constraint: string): boolean {
  if (constraint === "*" || constraint === "") return true;
  const v = parseVersion(version);
  const t = constraint.trim();

  if (t.startsWith("^")) {
    const { triple: c, given } = parseConstraintTriple(t.slice(1));
    /**
     * `^0.y.z` khoá cả minor — quy ước semver, và là chỗ dễ sai nhất.
     *
     * Chỉ áp khi minor ĐƯỢC NÊU: `^0` là `>=0.0.0 <1.0.0` theo npm, khác `^0.2` là
     * `>=0.2.0 <0.3.0`.
     */
    if (c[0] === 0 && given >= 2) {
      return v[0] === 0 && v[1] === c[1] && cmp(v, c) >= 0;
    }
    return v[0] === c[0] && cmp(v, c) >= 0;
  }

  if (t.startsWith("~")) {
    const { triple: c, given } = parseConstraintTriple(t.slice(1));
    if (given !== 3) {
      throw new Error(`oracle: dạng constraint không phủ: "${constraint}"`);
    }
    return v[0] === c[0] && v[1] === c[1] && cmp(v, c) >= 0;
  }

  if (t.startsWith(">=")) return cmp(v, parseConstraintTriple(t.slice(2)).triple) >= 0;
  if (t.startsWith("<=")) return cmp(v, parseConstraintTriple(t.slice(2)).triple) <= 0;
  if (t.startsWith(">")) return cmp(v, parseConstraintTriple(t.slice(1)).triple) > 0;
  if (t.startsWith("<")) return cmp(v, parseConstraintTriple(t.slice(1)).triple) < 0;

  if (/^\d/.test(t)) {
    const { triple: c, given } = parseConstraintTriple(t);
    if (given !== 3) {
      throw new Error(`oracle: dạng constraint không phủ: "${constraint}"`);
    }
    return cmp(v, c) === 0;
  }

  throw new Error(`oracle: dạng constraint không phủ: "${constraint}"`);
}

/** Mọi `CapabilityRequirement` của một adapter, phẳng hoá cả nhánh `anyOf` */
export function flatRequirements(
  a: OracleAdapter,
): CapabilityRequirement[] {
  return a.capabilities.requires.flatMap((r) => (isAnyOf(r) ? r.anyOf : [r]));
}

/** Adapter này có TIÊU THỤ `cap` không (kể cả qua một nhánh `anyOf`) */
export function consumes(a: OracleAdapter, cap: CapabilityId): boolean {
  return flatRequirements(a).some((r) => r.id === cap);
}

interface ProviderEntry {
  by: string;
  version: string;
  exclusive: boolean;
}

/**
 * Bước 1..7 của §5.3, viết tuần tự và DỪNG ở lỗi đầu tiên của mỗi bước.
 *
 * "Dừng ở lỗi đầu tiên" là ngữ nghĩa của pseudo-code (`return err(...)`), nên oracle giữ
 * đúng như thế. Gom mọi lỗi lại rồi trả về một lần là một thiết kế khác — có thể tốt hơn
 * cho UI, nhưng nó KHÔNG phải điều tài liệu nói, và một oracle "tốt hơn tài liệu" thì
 * không phán xử được gì.
 */
export function oracleValidate(
  adapters: readonly OracleAdapter[],
  prefs: readonly OraclePreference[] = [],
): OracleResult {
  const err = (
    code: OracleErrorCode,
    subject: string,
    detail: string[] = [],
  ): OracleResult => ({
    valid: false,
    errors: [{ code, subject, detail }],
    warnings: [],
    chosen: {},
    order: null,
  });

  // ---- 1. Bản đồ provider
  const provided = new Map<CapabilityId, ProviderEntry[]>();
  for (const a of adapters) {
    for (const p of a.capabilities.provides) {
      provided.set(p.id, [
        ...(provided.get(p.id) ?? []),
        { by: keyOf(a), version: p.version, exclusive: p.exclusive === true },
      ]);
    }
  }

  // ---- 2. exclusive: tối đa MỘT provider trong CLUSTER (D-5), độc lập preference
  for (const [cap, ps] of [...provided].sort(([a], [b]) => a.localeCompare(b))) {
    if (ps.length > 1 && ps.some((p) => p.exclusive)) {
      return err(
        "CONFLICT",
        cap,
        ps.map((p) => p.by).sort(),
      );
    }
  }

  // ---- 2b. conflicts tool-level, kiểm CẢ HAI CHIỀU
  const ids = new Set(adapters.map(keyOf));
  for (const a of adapters) {
    for (const c of a.capabilities.conflicts ?? []) {
      if (ids.has(c)) return err("CONFLICT", keyOf(a), [c]);
    }
  }

  // ---- 3. requires / anyOf / semver
  for (const a of adapters) {
    for (const r of a.capabilities.requires) {
      const alts = isAnyOf(r) ? r.anyOf : [r];
      const ok = alts.some((x) =>
        (provided.get(x.id) ?? []).some((p) =>
          oracleSatisfies(p.version, x.constraint ?? "*"),
        ),
      );
      if (ok) continue;
      if (isAnyOf(r)) {
        return err(
          "MISSING_ANY_OF",
          keyOf(a),
          alts.map((x) => x.id),
        );
      }
      const single = alts[0] as CapabilityRequirement;
      return err(
        provided.has(single.id) ? "VERSION_MISMATCH" : "MISSING_CAPABILITY",
        keyOf(a),
        [single.id],
      );
    }
  }

  // ---- 4. recommends: chỉ cảnh báo
  const warnings: OracleWarning[] = [];
  for (const a of adapters) {
    for (const c of a.capabilities.recommends ?? []) {
      if (!provided.has(c)) {
        warnings.push({ code: "RECOMMENDED_MISSING", subject: keyOf(a), detail: [c] });
      }
    }
  }

  // ---- 5. chọn provider
  const chosen: Record<string, string> = {};
  for (const [cap, ps] of [...provided].sort(([a], [b]) => a.localeCompare(b))) {
    const consumers = adapters.filter((a) => consumes(a, cap));
    /** D-10 — không ai tiêu thụ thì không chọn, và KHÔNG báo nhập nhằng */
    if (consumers.length === 0) continue;

    const satisfying = ps.filter((p) =>
      consumers.every((c) =>
        flatRequirements(c)
          .filter((r) => r.id === cap)
          .every((r) => oracleSatisfies(p.version, r.constraint ?? "*")),
      ),
    );

    const pref = prefs.find((p) => p.capabilityId === cap);
    if (pref !== undefined) {
      if (!ps.some((x) => x.by === pref.providerToolId)) {
        throw new OrphanPreferenceError(cap, pref.providerToolId);
      }
      /** D-4' — preference LÀ quyết định, và nêu TÊN nó khi nó không thoả */
      if (!satisfying.some((x) => x.by === pref.providerToolId)) {
        return err("VERSION_MISMATCH", pref.providerToolId, [cap]);
      }
      chosen[cap] = pref.providerToolId;
      continue;
    }

    if (satisfying.length === 0) {
      return err(
        "VERSION_MISMATCH",
        cap,
        ps.map((p) => p.by).sort(),
      );
    }
    if (satisfying.length === 1) {
      chosen[cap] = (satisfying[0] as ProviderEntry).by;
      continue;
    }
    /** Liệt kê CHỈ provider thoả — xem §5.3 */
    return err(
      "AMBIGUOUS_PROVIDER",
      cap,
      satisfying.map((p) => p.by).sort(),
    );
  }

  // ---- 6. verifyChosen
  for (const a of adapters) {
    for (const r of flatRequirements(a)) {
      const picked = chosen[r.id];
      if (picked === undefined) continue;
      const version = provided.get(r.id)?.find((p) => p.by === picked)?.version;
      if (version === undefined) continue;
      if (!oracleSatisfies(version, r.constraint ?? "*")) {
        return err("VERSION_MISMATCH", keyOf(a), [r.id]);
      }
    }
  }

  // ---- 7. topological sort theo BẬC
  const order = oracleTopoSort(adapters, chosen);
  if (order === null) return err("CYCLIC_DEPENDENCY", "", []);

  return { valid: true, errors: [], warnings, chosen, order };
}

/**
 * Topo sort theo BẬC, trên đồ thị capability của TỔ HỢP ĐÃ CHỌN (D-11).
 *
 * Cạnh đi từ provider ĐÃ CHỌN của một capability tới adapter tiêu thụ nó. Điều đó khác
 * "topo sort cả registry" theo hai chiều cùng lúc: cả registry cho chu trình GIẢ (Flagger
 * và Argo Rollouts không bao giờ cùng được chọn), còn với 16 adapter thật thì không bao
 * giờ có chu trình nên phép kiểm luôn xanh bất kể thuật toán đúng hay sai.
 *
 * Chịu được `chosen` THIẾU KHOÁ: một capability không ai tiêu thụ thì không có provider
 * được chọn, và không có cạnh nào — không phải một lỗi.
 */
export function oracleTopoSort(
  adapters: readonly OracleAdapter[],
  chosen: Readonly<Record<string, string>>,
): string[][] | null {
  const keys = adapters.map(keyOf);
  const deps = new Map<string, Set<string>>(keys.map((k) => [k, new Set()]));

  for (const a of adapters) {
    for (const r of flatRequirements(a)) {
      const provider = chosen[r.id];
      if (provider === undefined || provider === keyOf(a)) continue;
      deps.get(keyOf(a))?.add(provider);
    }
  }

  const done = new Set<string>();
  const levels: string[][] = [];
  let remaining = [...keys];

  while (remaining.length > 0) {
    const ready = remaining.filter((k) =>
      [...(deps.get(k) ?? [])].every((d) => done.has(d) || !keys.includes(d)),
    );
    /** Không ai sẵn sàng mà vẫn còn adapter ⇒ chu trình */
    if (ready.length === 0) return null;
    levels.push([...ready].sort());
    for (const k of ready) done.add(k);
    remaining = remaining.filter((k) => !done.has(k));
  }
  return levels;
}
