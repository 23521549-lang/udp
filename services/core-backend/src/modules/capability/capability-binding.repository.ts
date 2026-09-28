import type { CapabilityBinding } from "@udp/shared-types";
import { Prisma, type PrismaClient } from "@udp/db";

/**
 * [v4.10] Persist `CapabilityBinding` — giá trị THỰC TẾ sau khi adapter deploy xong.
 *
 * Nó là **cache dựng lại được**, không phải nguồn sự thật (ADR-08): nguồn sự thật là
 * trạng thái thật trên cluster, và `detectDrift()` đối chiếu với nó. Điều đó quyết định
 * hình dạng của tệp này — mọi lần ghi là một `UPSERT` idempotent, không có đường nào trả
 * lỗi "đã tồn tại": một lượt deploy chạy lại phải cho cùng kết quả.
 *
 * **Ràng buộc duy nhất là một EXPRESSION INDEX, và đó là lý do tệp này dùng SQL thô.**
 *
 * `idx_binding_unique` nằm trên
 * `(domain_config_id, capability_id, COALESCE(environment_id::text, ''))`.
 * Nó phải là expression index chứ không phải `UNIQUE` thường vì Postgres coi mỗi `NULL`
 * là **khác nhau**: hai binding cluster-scoped (`environment_id IS NULL`) trùng hệt nhau
 * vẫn lọt qua một `UNIQUE (domain_config_id, capability_id, environment_id)`.
 *
 * Prisma **không** suy được index biểu thức cho `upsert`, nên `ON CONFLICT` phải viết tay
 * kèm đúng danh sách biểu thức. Đó là cái giá của việc có một ràng buộc đúng, và nó rẻ
 * hơn cái giá của việc không có: hai binding cluster-scoped cùng capability nghĩa là
 * `chosen` có hai câu trả lời cho một câu hỏi, và không ai biết câu nào thắng.
 */

/**
 * `"<domainType>:<toolId>"` VIẾT THƯỜNG — khoá của `provided_by` và của `chosen`.
 *
 * Hai quy ước cùng tồn tại trong hệ thống, và cả hai đều có lý:
 *
 *  - `domain_catalog.domain_type` / `domain_configs.domain_type` viết HOA (`MONITORING`),
 *    theo lối mọi giá trị dạng enum của lược đồ.
 *  - `capability_bindings.provided_by` viết THƯỜNG (`monitoring:prometheus-grafana`),
 *    và §2.2 ghi rõ như vậy.
 *
 * Nên chỗ nối phải là MỘT hàm, không phải một lần `.toLowerCase()` rải ở từng chỗ dùng.
 * Rải ra thì một chỗ quên là một `provided_by` viết hoa nằm lẫn trong bảng, và nó không
 * khớp `chosen` của resolver — binding tồn tại nhưng không ai tìm thấy nó, và không có
 * lỗi nào được phát ra.
 */
export const providedByKey = (domainType: string, toolId: string): string =>
  `${domainType.toLowerCase()}:${toolId.toLowerCase()}`;

export interface BindingRow {
  domainConfigId: string;
  /** `undefined`/`null` = cluster-scoped */
  environmentId?: string | null;
  capabilityId: string;
  providedBy: string;
  schemaVersion: string;
  endpoint?: string | null;
  attributes?: Record<string, string> | null;
}

/** `CapabilityBinding` của `@udp/shared-types` → hàng của bảng */
export function bindingRowOf(
  domainConfigId: string,
  b: CapabilityBinding,
): BindingRow {
  return {
    domainConfigId,
    environmentId: b.environmentId ?? null,
    capabilityId: b.id,
    providedBy: b.providedBy,
    schemaVersion: b.version,
    endpoint: b.endpoint ?? null,
    attributes: b.attributes ?? null,
  };
}

type Tx = Pick<PrismaClient, "$executeRaw" | "$queryRaw">;

/**
 * Ghi một binding, idempotent theo đúng `idx_binding_unique`.
 *
 * `ON CONFLICT (domain_config_id, capability_id, COALESCE(environment_id::text, ''))`
 * lặp lại biểu thức của index từng chữ. Nếu hai bên lệch một dấu, Postgres báo
 * "there is no unique or exclusion constraint matching the ON CONFLICT specification" —
 * một lỗi rõ ràng lúc chạy, không phải một lần ghi trùng im lặng. Đó là lý do lặp lại
 * biểu thức ở đây an toàn hơn là cố suy nó ra.
 */
export async function upsertBinding(tx: Tx, row: BindingRow): Promise<void> {
  await tx.$executeRaw`
    INSERT INTO capability_bindings
      (id, domain_config_id, environment_id, capability_id, provided_by,
       schema_version, endpoint, attributes, updated_at)
    VALUES
      (gen_random_uuid(), ${row.domainConfigId}::uuid,
       ${row.environmentId ?? null}::uuid, ${row.capabilityId},
       ${row.providedBy}, ${row.schemaVersion}, ${row.endpoint ?? null},
       ${
         row.attributes === null || row.attributes === undefined
           ? null
           : JSON.stringify(row.attributes)
       }::jsonb,
       now())
    ON CONFLICT (domain_config_id, capability_id, COALESCE(environment_id::text, ''))
    DO UPDATE SET
      provided_by    = EXCLUDED.provided_by,
      schema_version = EXCLUDED.schema_version,
      endpoint       = EXCLUDED.endpoint,
      attributes     = EXCLUDED.attributes,
      updated_at     = now()`;
}

export interface StoredBinding extends BindingRow {
  id: string;
}

/** Mọi binding của một project, kể cả cluster-scoped */
export async function bindingsOfProject(
  prisma: PrismaClient,
  projectId: string,
): Promise<StoredBinding[]> {
  const rows = await prisma.capabilityBinding.findMany({
    where: { domainConfig: { projectId } },
    select: {
      id: true,
      domainConfigId: true,
      environmentId: true,
      capabilityId: true,
      providedBy: true,
      schemaVersion: true,
      endpoint: true,
      attributes: true,
    },
    orderBy: [{ capabilityId: "asc" }, { id: "asc" }],
  });
  return rows.map((r) => ({
    id: r.id,
    domainConfigId: r.domainConfigId,
    environmentId: r.environmentId,
    capabilityId: r.capabilityId,
    providedBy: r.providedBy,
    schemaVersion: r.schemaVersion,
    endpoint: r.endpoint,
    attributes: r.attributes as Record<string, string> | null,
  }));
}

/**
 * REBIND sau khi đổi provider — cho **MỌI** environment, không chỉ environment đang xem.
 *
 * Đây là trục mà AC-14 nêu, và là chỗ dễ làm sai nhất của cả tệp: `CapabilityBinding` có
 * `environmentId`, nên một lần "đổi Prometheus sang VictoriaMetrics" phải cập nhật cả
 * hàng cluster-scoped lẫn hàng của từng environment. Sửa đúng một hàng để lại những
 * environment khác trỏ tới provider ĐÃ TẮT — và chúng không báo lỗi gì, chúng chỉ đọc
 * metrics từ một endpoint không còn ai trả lời.
 *
 * Trả về số hàng đã đổi, để người gọi ghi audit được con số thật thay vì một lời hứa.
 */
export async function rebindProvider(
  tx: Tx,
  args: {
    projectId: string;
    /**
     * [v4.11] Domain đổi provider — CHỈ binding của nó được viết lại. §5.3 cho phép nhiều
     * provider không-exclusive cho cùng capability (Prometheus và VictoriaMetrics cùng cho
     * `metrics.query`); lọc theo capability thôi thì rebind một bên ghi đè binding của bên
     * kia, và preference chọn giữa hai bên không còn gì để chọn (Plan #30).
     */
    domainConfigId: string;
    capabilityId: string;
    /** `"<domainType>:<toolId>"` mới */
    providedBy: string;
    schemaVersion: string;
    endpoint?: string | null;
  },
): Promise<number> {
  return await tx.$executeRaw`
    UPDATE capability_bindings b
       SET provided_by    = ${args.providedBy},
           schema_version = ${args.schemaVersion},
           endpoint       = ${args.endpoint ?? null},
           updated_at     = now()
      FROM domain_configs d
     WHERE b.domain_config_id = d.id
       AND d.project_id = ${args.projectId}::uuid
       AND b.domain_config_id = ${args.domainConfigId}::uuid
       AND b.capability_id = ${args.capabilityId}`;
}

/** Xoá binding của một domain config (khi tắt domain) */
export async function deleteBindingsOfDomainConfig(
  tx: Tx,
  domainConfigId: string,
): Promise<number> {
  return await tx.$executeRaw`
    DELETE FROM capability_bindings
     WHERE domain_config_id = ${domainConfigId}::uuid`;
}

export { Prisma };
