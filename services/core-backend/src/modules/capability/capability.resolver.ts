import {
  isAnyOf,
  type CapabilityDeclaration,
  type CapabilityId,
  type CapabilityRequirement,
} from "@udp/shared-types";
import { satisfies, valid, validRange } from "semver";

/**
 * [v4.10] Bộ chọn provider và sắp thứ tự deploy — §5.3 sau bản sửa v4.10, SPEC §2.8.
 *
 * Đây là hiện thực SẢN PHẨM. Một hiện thực tham chiếu độc lập (oracle) sống ở
 * `tests/oracle/capability-oracle.ts`, được commit TRƯỚC tệp này, và không được import gì
 * từ đây — hai chốt cấu trúc trong `design-lint` cưỡng chế cả hai điều đó. Lý do: xem
 * chú thích đầu oracle.
 *
 * **Thứ tự ưu tiên TƯỜNG MINH**, và nó là phần dễ làm sai nhất:
 *
 * | Bước | Kiểm gì | Quan hệ với preference |
 * | --- | --- | --- |
 * | 1 | `conflicts` / `exclusive` | **ĐỘC LẬP** preference |
 * | 2 | `requires` / `anyOf` / semver | Chưa đọc preference |
 * | 3 | Chọn provider | Theo preference |
 * | 4 | `verifyChosen` | Consumer thoả constraint với provider **ĐÃ CHỌN** |
 *
 * `exclusive` là ràng buộc về **trạng thái cluster** (một cluster một bên điều khiển
 * traffic); preference là lựa chọn giữa nhiều cái hợp lệ. Cho preference thắng `exclusive`
 * nghĩa là một lựa chọn trên dropdown gỡ được một ràng buộc an toàn, và hệ quả là hai
 * controller cùng chia traffic trên một cluster.
 *
 * **Vì sao dùng `semver` chứ không tự viết:** oracle tự viết một bộ so sánh hẹp, và đó là
 * chủ ý — hai hiện thực phải có hai đường suy luận độc lập. Nếu cả hai dùng cùng một thư
 * viện thì differential test không kiểm được chính phần so version. Mã sản phẩm thì cần
 * bản đầy đủ, vì `constraint` do adapter khai và ta không kiểm soát được hết các dạng.
 */

export type ValidationErrorCode =
  | "MISSING_CAPABILITY"
  | "MISSING_ANY_OF"
  | "CONFLICT"
  | "VERSION_MISMATCH"
  | "AMBIGUOUS_PROVIDER"
  | "CYCLIC_DEPENDENCY";

export type ValidationWarningCode = "RECOMMENDED_MISSING";

export interface ResolvableAdapter {
  domainType: string;
  toolId: string;
  capabilities: CapabilityDeclaration;
}

export interface ProviderPreference {
  capabilityId: CapabilityId;
  /** `"<domainType>:<toolId>"` */
  providerToolId: string;
}

export interface ValidationIssue<TCode> {
  code: TCode;
  /** Khoá adapter (`"<domainType>:<toolId>"`) hoặc `CapabilityId` — theo §5.3 */
  subject: string;
  detail: string[];
}

export interface ValidationResult {
  valid: boolean;
  errors: ValidationIssue<ValidationErrorCode>[];
  warnings: ValidationIssue<ValidationWarningCode>[];
  /**
   * Provider đã chọn cho từng capability.
   *
   * **CÓ THỂ thiếu khoá** (D-10): một capability không adapter nào tiêu thụ thì không có
   * gì phải chọn. Mọi chỗ đọc phải chịu được `undefined` — một `chosen.get(cap)!` sẽ vỡ ở
   * đúng ca này, và ca này là một tổ hợp hoàn toàn hợp lệ.
   */
  chosen: Record<string, string>;
  /** Thứ tự deploy theo BẬC; các adapter cùng bậc deploy song song được */
  order: string[][] | null;
}

/**
 * Hàng `capability_preferences` mồ côi — LỖI KHỞI ĐỘNG, không phải một mã lỗi mới.
 *
 * `domain-config.diff.ts` phải xoá hàng đó **trong cùng transaction** với việc tắt/đổi
 * tool. §5.3 chọn đường này có chủ đích: thêm một mã lỗi là đổi danh mục lỗi của cả hệ
 * thống, còn bỏ im lặng lựa chọn của người dùng thì chính là lỗi D-4' vừa được sửa.
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

/**
 * Khai báo capability sai cú pháp — LỖI KHỞI ĐỘNG (§5.3: "khai sai ⇒ service không
 * khởi động").
 *
 * Kiểm ở đây chứ không tin vào kiểu: `version` và `constraint` là `string`, nên
 * TypeScript không thấy được `"2"` (thiếu minor/patch) hay `">=1 <2 ||"` (range vỡ).
 * Không kiểm thì `satisfies` trả `false` cho mọi thứ, và hệ thống báo `VERSION_MISMATCH`
 * cho một tổ hợp hợp lệ — một thông điệp gửi người dùng đi sửa cấu hình của họ vì một
 * lỗi khai báo của adapter.
 */
export class InvalidCapabilityDeclarationError extends Error {
  readonly code = "CAPABILITY_DECLARATION_INVALID";
  constructor(
    readonly adapter: string,
    readonly problem: string,
  ) {
    super(`khai báo capability của ${adapter} sai: ${problem}`);
    this.name = "InvalidCapabilityDeclarationError";
  }
}

/**
 * `"<domaintype>:<toolid>"` VIẾT THƯỜNG — cùng quy ước với `provided_by` và
 * `capability_preferences.provider_tool_id` (§2.2) và với `registryKey` của registry.
 *
 * [v4.11] Bản trước giữ nguyên chữ hoa của `domainType` (`MONITORING:…`) trong khi
 * preference lưu ở database viết thường: mọi preference thật bị ném thành
 * `OrphanPreferenceError`. Test không thấy vì fixture dùng `domainType: "d"`.
 */
export const adapterKey = (a: ResolvableAdapter): string =>
  `${a.domainType}:${a.toolId}`.toLowerCase();

/** Mọi `CapabilityRequirement` của một adapter, phẳng hoá cả nhánh `anyOf` */
export function flatRequirements(
  a: ResolvableAdapter,
): CapabilityRequirement[] {
  return a.capabilities.requires.flatMap((r) => (isAnyOf(r) ? r.anyOf : [r]));
}

/** Adapter này có TIÊU THỤ `cap` không (kể cả qua một nhánh `anyOf`) */
export const consumes = (a: ResolvableAdapter, cap: CapabilityId): boolean =>
  flatRequirements(a).some((r) => r.id === cap);

/**
 * Kiểm cú pháp khai báo, gọi TRƯỚC mọi bước khác.
 *
 * Nó là một hàm riêng chứ không nằm trong `validateAndOrder` vì registry gọi nó lúc NẠP
 * adapter (fail-fast lúc khởi động), còn `validateAndOrder` chạy mỗi lần người dùng đổi
 * tổ hợp. Hai thời điểm khác nhau, cùng một luật.
 */
export function assertDeclarationValid(a: ResolvableAdapter): void {
  const key = adapterKey(a);
  for (const p of a.capabilities.provides) {
    if (valid(p.version) === null) {
      throw new InvalidCapabilityDeclarationError(
        key,
        `version "${p.version}" của ${p.id} không phải semver đầy đủ x.y.z`,
      );
    }
  }
  for (const r of a.capabilities.requires) {
    const alts = isAnyOf(r) ? r.anyOf : [r];
    if (isAnyOf(r) && alts.length < 2) {
      throw new InvalidCapabilityDeclarationError(
        key,
        `anyOf phải có từ hai nhánh, thấy ${String(alts.length)}`,
      );
    }
    for (const x of alts) {
      if (x.constraint !== undefined && validRange(x.constraint) === null) {
        throw new InvalidCapabilityDeclarationError(
          key,
          `constraint "${x.constraint}" của ${x.id} không phải khoảng semver`,
        );
      }
    }
  }
}

interface ProviderEntry {
  by: string;
  version: string;
  exclusive: boolean;
}

function issue<TCode>(
  code: TCode,
  subject: string,
  detail: string[] = [],
): ValidationIssue<TCode> {
  return { code, subject, detail };
}

function failure(
  code: ValidationErrorCode,
  subject: string,
  detail: string[] = [],
): ValidationResult {
  return {
    valid: false,
    errors: [issue(code, subject, detail)],
    warnings: [],
    chosen: {},
    order: null,
  };
}

/**
 * Bảy bước của §5.3, và DỪNG ở lỗi đầu tiên.
 *
 * "Dừng ở lỗi đầu tiên" là ngữ nghĩa của pseudo-code, và giữ đúng nó là điều kiện để
 * differential test so được: một hiện thực gom mọi lỗi lại có thể hợp lý hơn cho UI,
 * nhưng nó trả về một thứ khác với thứ tài liệu nói, nên oracle không phán xử được.
 * Nếu sau này muốn gom lỗi thì phải sửa tài liệu và oracle trước.
 */
export function validateAndOrder(
  adapters: readonly ResolvableAdapter[],
  prefs: readonly ProviderPreference[] = [],
): ValidationResult {
  for (const a of adapters) assertDeclarationValid(a);

  /**
   * [v4.10] Duyệt theo khoá ĐÃ SẮP, không theo thứ tự đầu vào.
   *
   * "Dừng ở lỗi đầu tiên" cộng một danh sách phản ánh thứ tự người dùng bật tool làm
   * **lỗi báo về phụ thuộc thứ tự bật**: một tổ hợp có cả một adapter thiếu capability
   * và một adapter sai version sẽ báo `MISSING_CAPABILITY` hay `VERSION_MISMATCH` tùy
   * người dùng bật cái nào trước. Họ thấy điều đó dưới dạng "bật lại theo thứ tự
   * khác thì lỗi đổi" — một hành vi không ai tái tạo được để báo lỗi.
   *
   * Phát hiện bởi phép kiểm tính chất theo hoán vị, **không** bởi 2000 mẫu differential:
   * oracle viết từ cùng bản tài liệu nên nó sai giống hệt.
   */
  const inOrder = [...adapters].sort((x, y) =>
    adapterKey(x).localeCompare(adapterKey(y)),
  );

  // ---- 1. Bản đồ provider
  const provided = new Map<CapabilityId, ProviderEntry[]>();
  for (const a of inOrder) {
    for (const p of a.capabilities.provides) {
      provided.set(p.id, [
        ...(provided.get(p.id) ?? []),
        {
          by: adapterKey(a),
          version: p.version,
          exclusive: p.exclusive === true,
        },
      ]);
    }
  }

  /**
   * Thứ tự duyệt capability được SẮP, không theo thứ tự chèn của `Map`.
   *
   * Nếu không sắp, lỗi trả về phụ thuộc thứ tự người dùng bật tool — hai tổ hợp giống
   * nhau về nội dung cho hai thông báo khác nhau, và phép kiểm tính chất "bất biến theo
   * hoán vị" đỏ. Người dùng thấy điều đó dưới dạng "bật lại theo thứ tự khác thì lỗi đổi".
   */
  const capsInOrder = [...provided.keys()].sort((x, y) => x.localeCompare(y));

  // ---- 2. exclusive: tối đa MỘT provider trong CLUSTER (D-5), ĐỘC LẬP preference
  for (const cap of capsInOrder) {
    const ps = provided.get(cap) ?? [];
    if (ps.length > 1 && ps.some((p) => p.exclusive)) {
      return failure("CONFLICT", cap, ps.map((p) => p.by).sort());
    }
  }

  // ---- 2b. conflicts tool-level, kiểm CẢ HAI CHIỀU
  const present = new Set(adapters.map(adapterKey));
  for (const a of inOrder) {
    for (const c of a.capabilities.conflicts ?? []) {
      if (present.has(c)) return failure("CONFLICT", adapterKey(a), [c]);
    }
  }

  // ---- 3. requires / anyOf / semver
  for (const a of inOrder) {
    for (const r of a.capabilities.requires) {
      const alts = isAnyOf(r) ? r.anyOf : [r];
      const ok = alts.some((x) =>
        (provided.get(x.id) ?? []).some((p) =>
          satisfies(p.version, x.constraint ?? "*"),
        ),
      );
      if (ok) continue;
      if (isAnyOf(r)) {
        return failure(
          "MISSING_ANY_OF",
          adapterKey(a),
          alts.map((x) => x.id),
        );
      }
      const only = alts[0];
      if (only === undefined) continue;
      return failure(
        provided.has(only.id) ? "VERSION_MISMATCH" : "MISSING_CAPABILITY",
        adapterKey(a),
        [only.id],
      );
    }
  }

  // ---- 4. recommends: chỉ cảnh báo, KHÔNG đổi thứ tự deploy
  const warnings: ValidationIssue<ValidationWarningCode>[] = [];
  for (const a of inOrder) {
    for (const c of a.capabilities.recommends ?? []) {
      if (!provided.has(c)) {
        warnings.push(issue("RECOMMENDED_MISSING", adapterKey(a), [c]));
      }
    }
  }

  // ---- 5. chọn provider
  const chosen: Record<string, string> = {};
  for (const cap of capsInOrder) {
    const ps = provided.get(cap) ?? [];
    const consumers = inOrder.filter((a) => consumes(a, cap));
    /** D-10 — không ai tiêu thụ thì KHÔNG chọn và KHÔNG báo nhập nhằng */
    if (consumers.length === 0) continue;

    const satisfying = ps.filter((p) =>
      consumers.every((c) =>
        flatRequirements(c)
          .filter((r) => r.id === cap)
          .every((r) => satisfies(p.version, r.constraint ?? "*")),
      ),
    );

    const pref = prefs.find((p) => p.capabilityId === cap);
    if (pref !== undefined) {
      if (!ps.some((x) => x.by === pref.providerToolId)) {
        throw new OrphanPreferenceError(cap, pref.providerToolId);
      }
      /** D-4' — preference LÀ quyết định; không thoả thì nêu TÊN nó */
      if (!satisfying.some((x) => x.by === pref.providerToolId)) {
        return failure("VERSION_MISMATCH", pref.providerToolId, [cap]);
      }
      chosen[cap] = pref.providerToolId;
      continue;
    }

    if (satisfying.length === 0) {
      return failure("VERSION_MISMATCH", cap, ps.map((p) => p.by).sort());
    }
    const single = satisfying[0];
    if (satisfying.length === 1 && single !== undefined) {
      chosen[cap] = single.by;
      continue;
    }
    /**
     * Liệt kê CHỈ provider thoả.
     *
     * Đưa cả provider không thoả vào dropdown là mời người dùng chọn một lựa chọn sẽ
     * `VERSION_MISMATCH` ở bước 6 — tức một vòng lặp mà họ không hiểu vì sao.
     */
    return failure(
      "AMBIGUOUS_PROVIDER",
      cap,
      satisfying.map((p) => p.by).sort(),
    );
  }

  // ---- 6. verifyChosen
  /**
   * Bước 3 hỏi "có provider nào thoả không"; bước này hỏi "cái ĐÃ CHỌN có thoả không".
   *
   * Thiếu nó thì Flagger `^2` bind vào Datadog 1.0.0 và validator trả `ok` — và chính ví
   * dụ §5.3 dùng để minh hoạ `VERSION_MISMATCH` lại lọt qua ở đường khác.
   */
  for (const a of inOrder) {
    for (const r of flatRequirements(a)) {
      const picked = chosen[r.id];
      if (picked === undefined) continue;
      const version = provided.get(r.id)?.find((p) => p.by === picked)?.version;
      if (version === undefined) continue;
      if (!satisfies(version, r.constraint ?? "*")) {
        return failure("VERSION_MISMATCH", adapterKey(a), [r.id]);
      }
    }
  }

  // ---- 7. Topological sort theo BẬC
  const order = topoSort(adapters, chosen);
  if (order === null) return failure("CYCLIC_DEPENDENCY", "", []);

  return { valid: true, errors: [], warnings, chosen, order };
}

/**
 * Sắp thứ tự deploy theo BẬC, trên đồ thị capability của TỔ HỢP ĐÃ CHỌN (D-11).
 *
 * Cạnh đi từ provider ĐÃ CHỌN tới adapter tiêu thụ. Đó là điểm sửa của D-11: bản cũ chạy
 * `topoSort` trên **toàn bộ registry**, và sai theo hai chiều cùng lúc — 16 adapter thật
 * không bao giờ có chu trình nên phép kiểm luôn xanh bất kể thuật toán đúng hay sai, còn
 * topo sort cả registry lại cho chu trình GIẢ vì Flagger và Argo Rollouts không bao giờ
 * cùng được chọn.
 *
 * **Tự-vòng KHÔNG phải chu trình:** một adapter provide và tiêu thụ cùng một capability
 * tự thoả, nó không chờ ai. Coi đó là chu trình sẽ chặn một tổ hợp hợp lệ, với một thông
 * điệp `CYCLIC_DEPENDENCY` không nói đỉnh nào.
 */
export function topoSort(
  adapters: readonly ResolvableAdapter[],
  chosen: Readonly<Record<string, string>>,
): string[][] | null {
  const keys = adapters.map(adapterKey);
  const known = new Set(keys);
  const deps = new Map<string, Set<string>>(keys.map((k) => [k, new Set()]));

  for (const a of adapters) {
    const self = adapterKey(a);
    for (const r of flatRequirements(a)) {
      const provider = chosen[r.id];
      if (provider === undefined || provider === self) continue;
      if (!known.has(provider)) continue;
      deps.get(self)?.add(provider);
    }
  }

  const done = new Set<string>();
  const levels: string[][] = [];
  let remaining = [...keys];

  while (remaining.length > 0) {
    const ready = remaining.filter((k) =>
      [...(deps.get(k) ?? [])].every((d) => done.has(d)),
    );
    if (ready.length === 0) return null;
    levels.push([...ready].sort());
    for (const k of ready) done.add(k);
    remaining = remaining.filter((k) => !done.has(k));
  }
  return levels;
}
