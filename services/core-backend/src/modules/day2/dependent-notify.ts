import type {
  DomainAdapter,
  DomainAdapterContext,
  DomainToolConfig,
} from "@udp/adapter-core";
import type { CapabilityBinding } from "@udp/shared-types";
import { consumes } from "../capability/capability.resolver.js";

/**
 * [v4.10] Nửa THÔNG BÁO của CASE 3 (§8.2) - `onDependencyChanged` cho mọi consumer.
 *
 * P16 đã làm nửa DATABASE: `rebindProvider` đổi `provided_by` và `endpoint` cho mọi
 * environment. Nhưng một hàng database đã đổi mà consumer chưa biết thì consumer vẫn
 * đang chạy với endpoint cũ trong ConfigMap của nó - nó không báo lỗi gì, nó chỉ đọc
 * metrics từ một địa chỉ không còn ai trả lời. Nửa còn lại nằm ở đây.
 *
 * **Một hàm cho hai luồng**, và đó là quy tắc thứ tư của §8.6: *"nâng cấp và đổi tool đều
 * dẫn tới 'binding đổi ⇒ consumer phải biết', nên chung một hàm"*. Viết đường thứ hai cho
 * nâng cấp nghĩa là hai nơi phải cùng đúng về thứ tự topo, về việc consumer nào tiêu thụ
 * capability nào, và về chuyện một consumer lỗi thì những consumer còn lại ra sao.
 */

export interface Dependent {
  domainConfigId: string;
  adapter: DomainAdapter;
  config: DomainToolConfig;
}

export interface NotifyOutcome {
  domainConfigId: string;
  toolId: string;
  capabilityId: string;
  status: "NOTIFIED" | "SKIPPED" | "FAILED";
  message?: string;
}

export interface NotifyPorts {
  contextFor: (dependent: Dependent) => Promise<DomainAdapterContext>;
  /** Ghi lỗi vào `last_error` của ĐÚNG consumer đã lỗi, không phải của provider */
  recordFailure: (domainConfigId: string, message: string) => Promise<void>;
}

/**
 * Thông báo cho từng consumer, theo thứ tự đã cho.
 *
 * `dependents` phải được người gọi sắp theo **bậc topo** (`topoSort` của resolver): một
 * consumer chuỗi (A dùng B, B dùng C) phải nghe tin sau khi thứ nó phụ thuộc đã ổn định,
 * nếu không nó đọc lại một endpoint đang trên đường đổi.
 *
 * **Một consumer lỗi KHÔNG dừng những consumer còn lại.** Dừng cả vòng ở lỗi đầu tiên
 * nghĩa là một adapter hỏng đủ sức giữ cả project ở trạng thái nửa vời, và trạng thái nửa
 * vời đó không hiện ở đâu cả. Đổi lại, mỗi lỗi được ghi vào `last_error` của chính
 * consumer đó, nên Portal hiện đúng domain nào chưa nhận được tin.
 */
export async function notifyDependents(
  changed: readonly CapabilityBinding[],
  dependents: readonly Dependent[],
  ports: NotifyPorts,
): Promise<NotifyOutcome[]> {
  const out: NotifyOutcome[] = [];

  for (const dependent of dependents) {
    for (const binding of changed) {
      const base = {
        domainConfigId: dependent.domainConfigId,
        toolId: dependent.adapter.toolId,
        capabilityId: binding.id,
      };
      /**
       * Chỉ gọi khi consumer THẬT SỰ tiêu thụ capability đó.
       *
       * Gọi cho mọi cặp rồi để adapter tự bỏ qua là đẩy một quyết định của nền tảng xuống
       * cho 16 adapter, và mỗi adapter sẽ bỏ qua theo một kiểu. `consumes` đọc chính khai
       * báo `requires` (phẳng hoá cả nhánh `anyOf`), nên nó là cùng một nguồn sự thật mà
       * resolver dùng để dựng đồ thị.
       */
      if (!consumes(dependent.adapter, binding.id)) {
        out.push({ ...base, status: "SKIPPED" });
        continue;
      }

      try {
        const ctx = await ports.contextFor(dependent);
        const res = await dependent.adapter.onDependencyChanged(
          ctx,
          dependent.config,
          binding,
        );
        if (res.status === "SUCCESS") {
          out.push({ ...base, status: "NOTIFIED" });
          continue;
        }
        const message =
          res.message ?? "adapter trả FAILED mà không kèm thông điệp";
        await ports.recordFailure(dependent.domainConfigId, message);
        out.push({ ...base, status: "FAILED", message });
      } catch (err) {
        /** Chỉ `name` khi lỗi không phải của ta - §12 T3 */
        const message = err instanceof Error ? err.name : "lỗi không rõ";
        await ports.recordFailure(dependent.domainConfigId, message);
        out.push({ ...base, status: "FAILED", message });
      }
    }
  }

  return out;
}
