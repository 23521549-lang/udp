import { readOnlyContext } from "@udp/adapter-core";
import type { DomainAdapter, DomainAdapterContext } from "@udp/adapter-core";
import {
  driftRecordOf,
  type Day2DomainRow,
  type DriftRecord,
} from "./domain-config.repository.js";

/**
 * [v4.10] Job `DRIFT_SCAN` của §8.6 nhánh A - PHÁT HIỆN, và không bao giờ SỬA.
 *
 * Đây là chỗ mà ba chiều của bất biến I32 gặp nhau, nên cả ba được nói thẳng ở đây:
 *
 * | Chiều | Bảo đảm bởi |
 * | --- | --- |
 * | (a) sửa tay trên cluster ⇒ `drifted = true` kèm diff đúng chỗ | `detectDrift` của adapter, lưới 5 sửa đổi E16 kiểm |
 * | (b) quét ngay sau deploy ⇒ `drifted = false` | ô d12 của bộ hợp đồng, cho cả bốn adapter |
 * | (c) drift tồn tại qua 3 chu kỳ ⇒ không tự ghi đè | **tệp này**: `readOnlyContext` + chỉ ghi `last_error` |
 *
 * Chiều (c) được cưỡng chế ba tầng, và mỗi tầng bắt một loại lỗi khác:
 *
 *  1. **Kiểu.** `detectDrift` nhận `ReadOnlyAdapterContext`, nên không có `write` để gọi.
 *  2. **Lúc chạy.** `readOnlyContext` trả về một client MỚI chỉ có `read`: một lời gọi
 *     `write` lách qua tầng kiểu bằng `as` là `TypeError` tại chỗ, không phải một lần ghi
 *     đè vào cluster của khách.
 *  3. **Đếm.** Bộ hợp đồng trao cho adapter một bối cảnh đầy đủ rồi đếm verb ghi - ô bắt
 *     gian, vì phương thức trong TypeScript là song biến.
 *
 * Vì sao không tự sửa, nói bằng lời của §8.6: *"trôi thường là người vận hành cố ý vá
 * nóng lúc sự cố; tự ghi đè lúc 3 giờ sáng là biến một sự cố thành hai"*. Argo CD mặc
 * định tự sync, Helm chỉ biết khi có người chạy `diff`; UDP chọn chỗ thứ ba, và phép đo
 * E16 biến lựa chọn đó thành một vị trí có số liệu thay vì một sở thích.
 */

export type DriftVerdict =
  /** Không trôi - và nếu badge cũ là badge của quét thì badge được dọn */
  | "CLEAN"
  /** Trôi thật: `last_error.adapterResult = "DRIFTED"` */
  | "DRIFTED"
  /** Adapter trả FAILED hoặc ném - KHÔNG phải drift, và không được hiện như drift */
  | "SCAN_FAILED"
  /** Catalog trỏ tới một tool mà registry không còn thấy */
  | "NO_ADAPTER";

export interface DriftScanOutcome {
  domainConfigId: string;
  domainType: string;
  toolId: string;
  verdict: DriftVerdict;
  details?: string;
  /** Có ghi `last_error` trong lượt này hay không - xem `shouldWrite` */
  wrote: boolean;
}

export interface DriftScanPorts {
  /**
   * Adapter đang phục vụ một cặp `(domainType, toolId)`, hoặc `undefined`.
   *
   * Trả `undefined` thay vì ném: một tool biến mất khỏi registry là một sự kiện vận hành
   * bình thường (ai đó bỏ một adapter khỏi bản build), và nó phải thành một dòng
   * `last_error` cho ĐÚNG domain đó, không phải một exception giết cả lượt quét của 15
   * domain còn lại.
   */
  adapterFor: (domainType: string, toolId: string) => DomainAdapter | undefined;
  /**
   * Bối cảnh ĐẦY ĐỦ của một domain.
   *
   * Job có nó vì nó cùng process với luồng deploy. `scanDomainDrift` là chỗ DUY NHẤT hạ
   * nó xuống bối cảnh chỉ đọc, nên "quyền ghi dừng ở đây" là một dòng chỉ ra được.
   */
  contextFor: (row: Day2DomainRow) => Promise<DomainAdapterContext>;
  writeDrift: (
    domainConfigId: string,
    record: DriftRecord | null,
  ) => Promise<void>;
  now?: () => Date;
}

/**
 * Có phải ghi `last_error` không - và mặc định là KHÔNG.
 *
 * Một lượt quét mỗi 6 giờ trên một project sạch mà vẫn `UPDATE` từng hàng thì
 * `updated_at` của mọi domain nhảy 4 lần một ngày, và cột đó là thứ Portal dùng để nói
 * "đổi lần cuối lúc nào". Ghi chỉ khi PHÁN QUYẾT đổi, nên ba chu kỳ quét trên một domain
 * đang trôi cho đúng MỘT lần ghi - và đó cũng chính là điều phép kiểm ba chu kỳ của I32
 * chiều (c) khẳng định.
 */
function shouldWrite(current: unknown, next: DriftRecord | null): boolean {
  const before = driftRecordOf(current);
  if (next === null) {
    /** Sạch: chỉ dọn badge do chính lượt quét ghi, không chạm lỗi của luồng khác */
    return before !== null;
  }
  if (before === null) return true;
  return (
    before.adapterResult !== next.adapterResult ||
    before.message !== next.message
  );
}

/**
 * Quét một danh sách hàng đã lọc `ACTIVE` - hàm thuần trên các cổng được tiêm.
 *
 * Chưa có lịch biểu (`pg-boss` cron mỗi 6 giờ) và chưa có route
 * `POST /domains/:type/drift`: hai thứ đó nằm trong sổ nợ với điều kiện chạy được của
 * chúng. Cùng lý lẽ với P5 - phần QUYẾT ĐỊNH của luồng là phần đáng kiểm, và nó kiểm
 * được mà không cần dựng một hàng đợi.
 */
export async function scanDomainDrift(
  rows: readonly Day2DomainRow[],
  ports: DriftScanPorts,
): Promise<DriftScanOutcome[]> {
  const now = ports.now ?? (() => new Date());
  const out: DriftScanOutcome[] = [];

  for (const row of rows) {
    const base = {
      domainConfigId: row.id,
      domainType: row.domainType,
      toolId: row.selectedTool,
    };

    const adapter = ports.adapterFor(row.domainType, row.selectedTool);
    if (adapter === undefined) {
      const record: DriftRecord = {
        step: "DRIFT_SCAN",
        message: `không còn adapter cho ${row.domainType}:${row.selectedTool}`,
        adapterResult: "FAILED",
        at: now().toISOString(),
      };
      const wrote = shouldWrite(row.lastError, record);
      if (wrote) await ports.writeDrift(row.id, record);
      out.push({
        ...base,
        verdict: "NO_ADAPTER",
        details: record.message,
        wrote,
      });
      continue;
    }

    let record: DriftRecord | null = null;
    let verdict: DriftVerdict = "CLEAN";
    let details: string | undefined;

    try {
      const ctx = await ports.contextFor(row);
      /** CHỖ DUY NHẤT hạ quyền: từ đây trở đi không ai ghi được lên cluster */
      const res = await adapter.detectDrift(
        readOnlyContext(ctx),
        row.toolConfig,
      );
      /**
       * `SUCCESS` mà `data` vắng là một vi phạm hợp đồng, và nó KHÔNG được coi là sạch.
       *
       * `AdapterResult.data` là tuỳ chọn ở tầng kiểu, nên một adapter trả
       * `{ status: "SUCCESS" }` biên dịch được. Đọc nó thành "không trôi" nghĩa là một
       * adapter viết lỗi làm mọi domain của nó xanh vĩnh viễn - đúng loại im lặng mà cả
       * §4.5 lẫn §8.6 đều cấm.
       */
      if (res.status !== "SUCCESS" || res.data === undefined) {
        verdict = "SCAN_FAILED";
        details =
          res.message ??
          (res.status === "SUCCESS"
            ? "adapter trả SUCCESS mà không có kết quả quét"
            : "adapter trả FAILED mà không kèm thông điệp");
        record = {
          step: "DRIFT_SCAN",
          message: details,
          adapterResult: "FAILED",
          at: now().toISOString(),
        };
      } else if (res.data.drifted) {
        verdict = "DRIFTED";
        details = res.data.details ?? "đã trôi cấu hình";
        record = {
          step: "DRIFT_SCAN",
          message: details,
          adapterResult: "DRIFTED",
          at: now().toISOString(),
        };
      }
    } catch (err) {
      /**
       * Một adapter NÉM không được phép giết lượt quét của các domain còn lại.
       *
       * Thông điệp chỉ lấy `name` khi lỗi không phải của ta: §12 T3 nói một số SDK nhét
       * credential vào `error.message`, và `last_error` là thứ Portal hiện lên.
       */
      verdict = "SCAN_FAILED";
      details = err instanceof Error ? err.name : "lỗi không rõ";
      record = {
        step: "DRIFT_SCAN",
        message: details,
        adapterResult: "FAILED",
        at: now().toISOString(),
      };
    }

    const wrote = shouldWrite(row.lastError, record);
    if (wrote) await ports.writeDrift(row.id, record);
    out.push({
      ...base,
      verdict,
      ...(details === undefined ? {} : { details }),
      wrote,
    });
  }

  return out;
}
