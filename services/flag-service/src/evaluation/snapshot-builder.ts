import type { Prisma } from "@udp/db";
import {
  canonicalJson,
  configHashOf,
  type Snapshot,
  type SnapshotEntry,
  type SnapshotRule,
  type SnapshotSegment,
} from "@udp/flag-evaluator";
import { flagServeDbSchema, type FlagServeWire } from "@udp/shared-types";
import {
  snapshotRowOf,
  type FlagRow,
  type SnapshotRow,
} from "./snapshot-row.js";

/**
 * Dựng snapshot hình dạng dây, và từ nó ra `config_hash` cùng delta (§3.2
 * `evaluation/snapshot-builder.ts`).
 *
 * Vì sao ở `evaluation/` chứ không trong `modules/flag/`: ba module nghiệp vụ cùng
 * cần nó — `flag`, `env-config`, `rule` — và §3.2 nói thẳng "Module A KHÔNG import
 * trực tiếp code nội bộ của Module B". Để nó trong repository của `flag` thì hai
 * module kia phải thò tay vào nội tạng của `flag` ngay lúc được viết ra. Nó cũng là
 * thứ `changefeed/` nạp vào cache — một hạ tầng không nên phụ thuộc vào một module
 * nghiệp vụ cụ thể.
 *
 * Hai nửa tách bạch: `snapshot-row.ts` ĐỌC (một câu lệnh SQL, đã validate),
 * file này DỰNG (`snapshotFromRow`, hàm thuần). Tách như vậy để phần dựng —
 * nơi mọi quyết định về hình dạng dây nằm — kiểm được bằng fixture mà không
 * cần database, còn phần đọc kiểm bằng golden hash trên database thật.
 */

/**
 * Khóa của một variant, tra theo id.
 *
 * Ném thay vì bỏ qua: trigger `UDP01` (§6.7) cưỡng chế rule chỉ trỏ variant của
 * chính flag mình, nên tra trượt nghĩa là hàng rào đó đã bị vượt qua. Trả một
 * snapshot thiếu rule đó là im lặng phục vụ sai variant cho tới khi có người để
 * ý — mà không ai để ý được, vì kết quả vẫn "hợp lệ".
 */
function variantKeyOf(
  byId: ReadonlyMap<string, string>,
  variantId: string,
  where: string,
): string {
  const key = byId.get(variantId);
  if (key === undefined) {
    throw new Error(
      `${where}: variant ${variantId} không thuộc flag này — trigger UDP01 lẽ ra ` +
        `đã chặn, nên dữ liệu trong database đã hỏng`,
    );
  }
  return key;
}

/**
 * Dịch `serve` từ hình dạng DB sang hình dạng dây: `variantId` → `variantKey`.
 *
 * Hai chi tiết không được đổi:
 *
 * - **`parse` trước khi dịch.** Cột là JSONB nên database không giữ hình dạng
 *   cho ta. Không parse ở đây thì một `serve` hỏng đi thẳng tới SDK và nổ trong
 *   tiến trình của khách hàng, ở đúng nhánh `pickVariant` tuyên bố "không tới
 *   được".
 * - **Giữ NGUYÊN thứ tự `weights`.** `pickVariant` cộng dồn theo thứ tự mảng,
 *   nên đảo nó là gán mọi người dùng sang variant khác. `.map()` giữ thứ tự;
 *   đừng thay bằng bất cứ thứ gì sắp lại.
 */
function serveOf(
  raw: unknown,
  byId: ReadonlyMap<string, string>,
  where: string,
): FlagServeWire {
  const serve = flagServeDbSchema.parse(raw);

  if (serve.kind === "variant") {
    return {
      kind: "variant",
      variantKey: variantKeyOf(byId, serve.variantId, where),
    };
  }

  return {
    kind: "distribution",
    weights: serve.weights.map((w) => ({
      variantKey: variantKeyOf(byId, w.variantId, where),
      weight: w.weight,
    })),
  };
}

// `conditions?`: zod khai `unknown` thành khoá tuỳ chọn; thiếu thì nhánh dưới ném đúng thông điệp
function segmentOf(row: { id: string; conditions?: unknown }): SnapshotSegment {
  if (!Array.isArray(row.conditions)) {
    throw new Error(
      `Segment ${row.id}: \`conditions\` không phải mảng. §2.2 khai đây là "mảng ` +
        `điều kiện nối bằng AND", nên một hình dạng khác là dữ liệu đã hỏng`,
    );
  }
  return { id: row.id, conditions: row.conditions };
}

function entryOf(flag: FlagRow): SnapshotEntry {
  /**
   * Flag đã lưu trữ vẫn có mặt, dưới dạng bia mộ (§6.5).
   *
   * Bỏ hẳn nó khỏi snapshot làm SDK trả `FLAG_NOT_FOUND` thay vì `DISABLED`
   * — với người viết ứng dụng, cái đầu nghĩa là "gõ sai tên", cái sau nghĩa
   * là "flag có thật, đang tắt". Hai câu trả lời khác nhau cho hai tình
   * huống khác nhau.
   */
  if (flag.lifecycleStatus === "ARCHIVED") {
    return { key: flag.key, archived: true };
  }

  const config = flag.envConfig;
  const byId = new Map(flag.variants.map((v) => [v.id, v.key] as const));
  const where = `Flag "${flag.key}"`;

  /**
   * Override của environment thắng default của flag (§6.5:
   * `envConfig.defaultVariantId ?? flag.defaultVariantId`).
   *
   * Trên dây chỉ có MỘT trường, nên phép chọn đó phải xảy ra ở đây. Gửi cả
   * hai xuống SDK là bắt hai bản cài đặt cùng nhớ thứ tự ưu tiên — và bên
   * nào quên thì phục vụ sai default mà hash vẫn khớp.
   */
  const defaultVariantId = config?.defaultVariantId ?? flag.defaultVariantId;

  if (defaultVariantId === null) {
    throw new Error(
      `${where}: không có variant mặc định. §9 khai \`defaultVariantKey\` là ` +
        `bắt buộc vì đó là giá trị SDK trả khi không rule nào khớp; thiếu nó ` +
        `thì flag không đánh giá được`,
    );
  }

  return {
    key: flag.key,
    type: flag.flagType,
    isEnabled: config?.isEnabled ?? false,
    stickinessAttribute: flag.stickinessAttribute,
    variants: Object.fromEntries(flag.variants.map((v) => [v.key, v.value])),
    defaultVariantKey: variantKeyOf(byId, defaultVariantId, where),
    rules: (config?.rules ?? []).map((rule): SnapshotRule => ({
      id: rule.id,
      type: rule.ruleType,
      condition: rule.condition,
      serve: serveOf(rule.serve, byId, `${where} rule ${rule.id}`),
      bucketSalt: rule.bucketSalt,
      priority: rule.priority,
    })),
  };
}

/**
 * Dựng snapshot của MỘT environment từ hàng đã đọc — đầu vào của `config_hash`,
 * và là chính payload `/sdk/config`. Hàm THUẦN: mọi quyết định về hình dạng dây
 * nằm ở đây, và kiểm được bằng fixture.
 *
 * Ba điều quyết định tính đúng của nó:
 *
 * 1. **Hình dạng là hình dạng DÂY (§9), không phải hình dạng thuận tay cho truy
 *    vấn.** `config_hash` là hợp đồng liên tiến trình: S2 ghi con số, còn SDK
 *    dựng lại snapshot từ delta đã nhận rồi tính lại và so — I15c nói "cùng từng
 *    bit". SDK chỉ có thứ nó NHẬN, nên thứ đem đi băm phải là thứ được gửi. Bản
 *    trước băm `variants[].id`, `defaultVariantId` và `envDefaultVariantId`, ba
 *    trường không bao giờ rời server, nên SDK không có cách nào tính ra con số
 *    S2 ghi — I15c hỏng bằng cấu trúc chứ không phải bằng bug.
 * 2. **Điều kiện environment nằm trong câu lệnh đọc** (`snapshot-row.ts`), nên
 *    hàng vào đây đã là của đúng một environment — I14 được quyết định ở đó.
 * 3. **`serve` được dịch id → key ngay tại đây.** Đây là ranh giới duy nhất mà
 *    hai hình dạng gặp nhau; để việc dịch trôi xuống controller là mở đường cho
 *    hai đường dịch khác nhau ở hai endpoint.
 */
export function snapshotFromRow(row: SnapshotRow): Snapshot {
  return {
    flags: row.flags.map(entryOf),
    segments: row.segments.map(segmentOf),

    /**
     * RỖNG trong lát cắt này, và đó là câu trả lời đúng — không phải chỗ trống
     * chờ lấp.
     *
     * §6.6 cho tập này đúng MỘT nguồn: Service 1 gọi
     * `POST /internal/rollouts/:id/track` (§9), và Service 2 thêm flag vào tập
     * trong một transaction ADR-05. Endpoint đó chưa có, nên tập rỗng.
     *
     * Đừng rút nó từ `rollout_sessions.status`, dù từ v4.1 `udp_s2` đọc được cột
     * đó để kiểm fencing. Status do Service 3 ghi, NGOÀI đường ghi của ADR-05:
     * rollout bắt đầu hay kết thúc thì snapshot đổi mà `config_version` đứng yên,
     * và `config_hash` đã ghi mô tả một trạng thái không còn đúng (I15a). §6.6 đặt
     * tập này trên đường lan truyền chung chính là để nó thừa hưởng bảo đảm đó
     * thay vì là một kênh thứ hai phải tự kiểm.
     */
    trackedFlags: [],
  };
}

/**
 * Snapshot của một environment, đọc bằng MỘT câu lệnh rồi dựng.
 *
 * Chạy được trong transaction ghi (`stateFor`) — ở đó nó là truy vấn duy nhất
 * dưới row-lock của `environments` ngoài chính các lệnh ghi.
 */
export async function snapshotOf(
  tx: Prisma.TransactionClient,
  environmentId: string,
): Promise<Snapshot> {
  const row = await snapshotRowOf(tx, environmentId);
  if (row === undefined) {
    throw new Error(
      `Environment ${environmentId} không tồn tại — không dựng được snapshot`,
    );
  }
  return snapshotFromRow(row);
}

/**
 * Delta ghi vào outbox: TOÀN BỘ entry của flag bị ảnh hưởng, ở hình dạng dây.
 *
 * §2.2 khai `payload` là "delta đầy đủ để replica cập nhật cache mà không phải
 * đọc lại toàn bộ". Bản trước ghi `{key, flagType}` cho `flag.created` và
 * `{flagId, changed: [...]}` cho `flag.updated` — cả hai đều nói *cái gì đã
 * đổi*, không nói *đổi thành gì*. Replica nhận chúng vẫn phải đọc lại toàn bộ,
 * nên tầng 2 tốn thêm một vòng database mà không nhanh hơn tầng 1; và nó trùng
 * vai tầng 3, vốn được ADR-05 khai rõ là "ĐÁNH THỨC vòng poll, không mang dữ
 * liệu". Hai tầng không thể cùng một việc.
 *
 * Áp delta = thay entry cùng `key` trong cache. Phép đó idempotent và không phụ
 * thuộc thứ tự giữa các flag — đúng thứ I15c cần để "áp N delta cho ra đúng
 * snapshot tại cùng version".
 *
 * Đi qua `canonicalJson` rồi `JSON.parse` chứ không ép kiểu thẳng, vì hai lý do
 * cộng lại: snapshot mang `unknown` ở đúng những chỗ ứng với cột JSONB nên
 * không chứng minh được với TypeScript rằng nó là JSON, và `canonicalJson` từ
 * chối đúng những giá trị `JSON.stringify` sẽ nuốt im lặng — `undefined` bị bỏ,
 * `NaN`/`Infinity` thành `null`. Giá phải trả là một lượt tuần tự hoá cho MỘT
 * flag.
 *
 * `extra` là các trường đi kèm entry, như `rolloutSessionId` của `rule.ramped`
 * (§2.2). Trải TRƯỚC `flag`, nên không trường thêm nào đè được entry.
 */
function deltaOf(
  snapshot: Snapshot,
  flagKey: string,
  extra: Readonly<Record<string, string>>,
): Prisma.InputJsonValue {
  const flag = snapshot.flags.find((f) => f.key === flagKey);

  if (flag === undefined) {
    throw new Error(
      `Không tìm thấy flag "${flagKey}" trong snapshot vừa dựng — mutate và ` +
        `delta đang nói về hai thứ khác nhau`,
    );
  }

  return JSON.parse(canonicalJson({ ...extra, flag })) as Prisma.InputJsonValue;
}

/**
 * Bước 3 và bước 4 của ADR-05, cả hai từ MỘT lần đọc snapshot.
 *
 * `snapshotOf` là truy vấn nặng nhất chạy dưới row-lock. Tính hash và dựng delta
 * là hai phép chiếu của cùng một trạng thái, nên đọc hai lần là trả giá đôi cho
 * cùng một thứ, ngay tại chỗ đắt nhất.
 *
 * `extra` đi thẳng vào payload outbox, cạnh entry — xem `deltaOf`.
 */
export const stateFor =
  (flagKey: string, extra: Readonly<Record<string, string>> = {}) =>
  async (
    tx: Prisma.TransactionClient,
    environmentId: string,
  ): Promise<{ configHash: string; delta: Prisma.InputJsonValue }> => {
    const snapshot = await snapshotOf(tx, environmentId);
    return {
      configHash: configHashOf(snapshot),
      delta: deltaOf(snapshot, flagKey, extra),
    };
  };
