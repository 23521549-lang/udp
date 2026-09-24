import { Prisma, type PrismaClient } from "@udp/db";

/**
 * [v4.10] Cột nào của `domain_configs` mà luồng Day-2 được phép chạm (§8.6).
 *
 * §5.2 định nghĩa `upgrade()` và `detectDrift()` từ v4, nhưng cho tới P21 không luồng nào
 * gọi chúng, nên một domain sau khi `ACTIVE` là đóng băng vĩnh viễn. Tệp này là nửa ĐỌC
 * VÀ GHI của luồng đó, và nó cố tình rất hẹp: một job quét nền chạy mỗi 6 giờ trên dữ
 * liệu của khách thì thứ đáng sợ không phải là nó quét sai, mà là nó SỬA.
 *
 * Bất biến I32 chiều (c) nói rõ: *"để drift tồn tại qua ba chu kỳ quét, khẳng định hệ
 * thống không tự ghi đè và không có lời gọi ghi nào lên cluster; chỉ có
 * `DomainConfig.last_error` được cập nhật"*. Nên hàm ghi duy nhất ở đây chỉ nhận một giá
 * trị `last_error` và không có tham số nào khác - không có đường nào để một lượt quét đổi
 * `domain_status`, `selected_tool`, `tool_config` hay `adapter_version`. Một hàm
 * `updateDomainConfig(id, data)` tổng quát sẽ tiện hơn và sẽ là chỗ để bất biến đó vỡ.
 */

/** Hàng mà một lượt quét cần - không nhiều hơn */
export interface Day2DomainRow {
  id: string;
  projectId: string;
  domainType: string;
  selectedTool: string;
  toolConfig: Record<string, unknown>;
  adapterVersion: string | null;
  /** Giá trị hiện tại, để biết có phải ghi hay không (xem `driftRecordOf`) */
  lastError: unknown;
}

/**
 * Hình dạng của `last_error` do một lượt quét ghi.
 *
 * Bám đúng hình dạng mà lược đồ đã ghi (`{ step, message, adapterResult }`) chứ không
 * bịa một hình dạng thứ hai: cột này còn được luồng provisioning ghi, và Portal đọc một
 * cột chứ không đọc hai.
 */
export interface DriftRecord {
  step: "DRIFT_SCAN";
  message: string;
  /** `DRIFTED` = đã trôi thật; `FAILED` = không quét được (hai việc khác nhau) */
  adapterResult: "DRIFTED" | "FAILED";
  at: string;
}

/**
 * `last_error` hiện tại có phải do một lượt quét ghi hay không.
 *
 * Phân biệt này là điều kiện để "quét xong thấy sạch thì xoá badge" không xoá mất một lỗi
 * của luồng khác: một domain `deploy` thất bại có `last_error` với `step = "DEPLOY"`, và
 * một lượt quét sạch KHÔNG được phép dọn nó - lỗi đó vẫn đúng, và nó là thứ người vận
 * hành đang cần thấy.
 */
export function driftRecordOf(value: unknown): DriftRecord | null {
  if (typeof value !== "object" || value === null) return null;
  const v = value as Record<string, unknown>;
  if (v.step !== "DRIFT_SCAN") return null;
  const result = v.adapterResult;
  if (result !== "DRIFTED" && result !== "FAILED") return null;
  return {
    step: "DRIFT_SCAN",
    message: typeof v.message === "string" ? v.message : "",
    adapterResult: result,
    at: typeof v.at === "string" ? v.at : "",
  };
}

/**
 * Domain nào của một project được quét: `ACTIVE` **và** đang bật.
 *
 * Hai điều kiện, không phải một. `domain_status = ACTIVE` mà `is_enabled = false` là
 * trạng thái của một domain vừa bị tắt nhưng chưa teardown xong; quét nó sẽ báo trôi (vì
 * trên cluster sắp không còn gì) và badge đó nói sai về nguyên nhân.
 *
 * `selected_tool` NULL bị loại ở tầng SQL: không có tool thì không có adapter để gọi, và
 * lọc ở đây rẻ hơn một nhánh `if` ở mọi chỗ dùng.
 */
export async function activeDomainsOfProject(
  prisma: PrismaClient,
  projectId: string,
): Promise<Day2DomainRow[]> {
  const rows = await prisma.domainConfig.findMany({
    where: {
      projectId,
      isEnabled: true,
      domainStatus: "ACTIVE",
      selectedTool: { not: null },
    },
    select: {
      id: true,
      projectId: true,
      domainType: true,
      selectedTool: true,
      toolConfig: true,
      adapterVersion: true,
      lastError: true,
    },
    orderBy: { domainType: "asc" },
  });

  return rows.map((r) => ({
    id: r.id,
    projectId: r.projectId,
    /** `selectedTool: { not: null }` ở trên đã lọc, nhưng kiểu của Prisma không biết */
    selectedTool: r.selectedTool ?? "",
    domainType: r.domainType,
    toolConfig:
      typeof r.toolConfig === "object" && r.toolConfig !== null
        ? (r.toolConfig as Record<string, unknown>)
        : {},
    adapterVersion: r.adapterVersion,
    lastError: r.lastError,
  }));
}

/**
 * Ghi kết quả một lượt quét - **chỉ** cột `last_error`.
 *
 * `updated_at` đổi theo, vì nó là `@updatedAt` của Prisma. Đó là đúng hai cột mà I32
 * chiều (c) cho phép đổi, và phép kiểm ba chu kỳ so ảnh chụp cả hàng để khẳng định không
 * có cột thứ ba nào nhúc nhích.
 */
export async function writeDriftRecord(
  prisma: PrismaClient,
  domainConfigId: string,
  record: DriftRecord | null,
): Promise<void> {
  await prisma.domainConfig.update({
    where: { id: domainConfigId },
    /**
     * `Prisma.DbNull`, KHONG phai `null`.
     *
     * Voi mot cot `Json?`, `null` cua JavaScript nghia la "khong doi gi"; xoa gia tri
     * phai noi bang `DbNull`. Viet `null` o day thi lan don badge khong bao gio xay ra,
     * va Portal hien "da troi cau hinh" mai mai sau khi van hanh da sua xong.
     */
    data: { lastError: record === null ? Prisma.DbNull : { ...record } },
  });
}
