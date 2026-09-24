import type { PrismaClient } from "@udp/db";
import {
  deleteBindingsOfDomainConfig,
  providedByKey,
  rebindProvider,
} from "./capability-binding.repository.js";

/**
 * [v4.10] Áp một lần đổi cấu hình domain, và DỌN theo nó trong CÙNG transaction.
 *
 * Việc chính của tệp này không phải ghi cấu hình mới mà là **không để lại rác trỏ tới
 * thứ vừa tắt**. Có đúng hai loại rác, và cả hai đều im lặng:
 *
 *  1. **Hàng `capability_preferences` mồ côi** — người dùng từng chọn Prometheus cho
 *     `metrics.query`, rồi tắt domain Monitoring. Hàng preference còn lại trỏ tới một
 *     tool không có trong tổ hợp, và §5.3 nói đó là **lỗi khởi động**. Nếu không xoá nó ở
 *     đây thì lần validate sau NÉM — tức người dùng tắt một domain và hệ thống không
 *     khởi động lại được, mà không có gì nói vì sao.
 *  2. **Hàng `capability_bindings` trỏ tới provider đã tắt** — chúng không báo lỗi, chúng
 *     chỉ trỏ tới một endpoint không còn ai trả lời.
 *
 * **Cùng một transaction** là phần không thể thương lượng: nếu cấu hình mới commit mà lần
 * xoá preference thì không, hệ thống ở đúng trạng thái mà §5.3 gọi là lỗi khởi động —
 * và lần khởi động kế tiếp là lần phát hiện.
 */

export interface DomainChange {
  domainConfigId: string;
  domainType: string;
  /** Tool mới; `null` = TẮT domain */
  selectedTool: string | null;
  /** Capability mà tool cũ provide — dùng để tìm preference mồ côi */
  capabilitiesOfOldTool: readonly string[];
  /**
   * Provider mới cho từng capability, khi đây là một lần ĐỔI TOOL.
   *
   * Vắng nghĩa là tắt hẳn: binding bị xoá thay vì rebind.
   */
  rebind?: readonly {
    capabilityId: string;
    providedBy: string;
    schemaVersion: string;
    endpoint?: string | null;
  }[];
  /**
   * [v4.10] `adapter_version` mới, khi lần đổi này là một lần NÂNG CẤP (§8.6).
   *
   * Vắng nghĩa là giữ nguyên - bật, tắt hay đổi tool đều không chạm cột này.
   *
   * Vì sao nó nằm ở ĐÂY chứ không là một `UPDATE` riêng của luồng nâng cấp: §8.6 nói
   * `adapter_version` chỉ đổi sau khi healthcheck xanh, và cột đó là thứ `detectDrift()`
   * so sánh. Hai lệnh `UPDATE` rời nhau để lại một cửa sổ mà binding đã mới còn version
   * còn cũ; một lần crash đúng trong cửa sổ đó làm MỌI lượt quét sau báo trôi giả, và
   * §8.6 gọi thẳng đó là hậu quả của việc ghi sai cột này.
   */
  adapterVersion?: string;
}

export interface DiffOutcome {
  /** Số hàng preference đã xoá vì mồ côi */
  preferencesRemoved: number;
  /** Số hàng binding đã rebind (mọi environment) */
  bindingsRebound: number;
  /** Số hàng binding đã xoá vì domain bị tắt */
  bindingsRemoved: number;
}

/**
 * Áp một lần đổi, tất cả trong một transaction.
 *
 * `prisma.$transaction` với một hàm: mọi lệnh bên trong dùng `tx`, nên một lỗi ở bất kỳ
 * bước nào cuộn lại toàn bộ. Không nhận `tx` từ ngoài vào có chủ đích — người gọi không
 * được phép quên bọc transaction, và cách chắc chắn nhất là hàm này tự mở.
 */
export async function applyDomainChange(
  prisma: PrismaClient,
  projectId: string,
  change: DomainChange,
): Promise<DiffOutcome> {
  return await prisma.$transaction(async (tx) => {
    let bindingsRebound = 0;
    let bindingsRemoved = 0;

    if (change.selectedTool === null) {
      bindingsRemoved = await deleteBindingsOfDomainConfig(
        tx,
        change.domainConfigId,
      );
    } else {
      for (const r of change.rebind ?? []) {
        bindingsRebound += await rebindProvider(tx, {
          projectId,
          capabilityId: r.capabilityId,
          providedBy: r.providedBy,
          schemaVersion: r.schemaVersion,
          endpoint: r.endpoint ?? null,
        });
      }
    }

    /**
     * Xoá preference của những capability mà tool CŨ provide và tool mới KHÔNG.
     *
     * Không xoá mọi preference của project: người dùng có thể đã chọn provider cho một
     * capability hoàn toàn khác, và xoá nó là bỏ im lặng một lựa chọn họ vẫn muốn — đúng
     * loại lỗi mà D-4' đang sửa ở chỗ khác.
     */
    const stillProvided = new Set(
      (change.rebind ?? []).map((r) => r.capabilityId),
    );
    const orphaned = change.capabilitiesOfOldTool.filter(
      (c) => !stillProvided.has(c),
    );

    let preferencesRemoved = 0;
    if (orphaned.length > 0) {
      const { count } = await tx.capabilityPreference.deleteMany({
        where: { projectId, capabilityId: { in: [...orphaned] } },
      });
      preferencesRemoved = count;
    }

    await tx.domainConfig.update({
      where: { id: change.domainConfigId },
      data: {
        selectedTool: change.selectedTool,
        isEnabled: change.selectedTool !== null,
        ...(change.adapterVersion === undefined
          ? {}
          : { adapterVersion: change.adapterVersion }),
      },
    });

    return { preferencesRemoved, bindingsRebound, bindingsRemoved };
  });
}

/**
 * Hàng preference nào ĐANG mồ côi — dùng cho chốt khởi động.
 *
 * §5.3: một hàng mồ côi còn lại là lỗi khởi động, không phải warning. Hàm này là phần
 * PHÁT HIỆN; phần NÉM nằm ở resolver (`OrphanPreferenceError`), vì chỉ resolver biết tổ
 * hợp đang chọn là gì.
 *
 * "Mồ côi" ở đây có nghĩa hẹp và chính xác: preference trỏ tới một `"<domainType>:<tool>"`
 * mà project không có `domain_config` nào đang bật với đúng cặp đó.
 */
export async function orphanPreferences(
  prisma: PrismaClient,
  projectId: string,
): Promise<{ capabilityId: string; providerToolId: string }[]> {
  const [prefs, configs] = await Promise.all([
    prisma.capabilityPreference.findMany({
      where: { projectId },
      select: { capabilityId: true, providerToolId: true },
      orderBy: { capabilityId: "asc" },
    }),
    prisma.domainConfig.findMany({
      where: { projectId, isEnabled: true },
      select: { domainType: true, selectedTool: true },
    }),
  ]);

  /**
   * `providedByKey` chứ KHÔNG phải nối chuỗi tay — và đây là chỗ bản đầu của hàm này sai.
   *
   * `domain_configs.domain_type` viết HOA (`MONITORING`) còn `provider_tool_id` của
   * preference viết THƯỜNG (`monitoring:prometheus-grafana`, §2.2). Nối tay thì không
   * khoá nào khớp, nên **mọi** preference trông như mồ côi — tức người dùng bật một
   * domain, chọn provider, rồi hệ thống không khởi động lại được. Phép kiểm
   * "preference trỏ tới tool đang bật ⇒ KHÔNG mồ côi" bắt đúng điều này.
   */
  const enabled = new Set(
    configs
      .filter((c) => c.selectedTool !== null)
      .map((c) => providedByKey(c.domainType, String(c.selectedTool))),
  );
  return prefs.filter((p) => !enabled.has(p.providerToolId));
}
