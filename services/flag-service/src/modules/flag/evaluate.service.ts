import { evaluate, prepareSnapshot } from "@udp/flag-evaluator";
import { snapshotFromRow, snapshotRowOf } from "@udp/flag-snapshot";
import { NotFoundError } from "@udp/http";
import type { TesterResult } from "@udp/shared-types";
import { prisma } from "../../core/db.js";
import * as repository from "./flag.repository.js";

const NOT_FOUND = "Không tìm thấy flag ở environment này";

/**
 * Flag Evaluation Tester (§10.12, §9 `POST /internal/flags/:id/evaluate`) [v4.6]
 * — CÙNG hàm đánh giá với SDK và OFREP (I26), trên snapshot của environment.
 *
 * Đọc snapshot THẲNG từ database, không qua cache của `/sdk/*`, vì hai lý do:
 *   - người thử vừa lưu rule xong: cache có thể chưa đuổi kịp, và "thử ngay sau
 *     khi lưu" là đúng ca người ta dùng Tester;
 *   - `configCache.get` đưa environment vào tập watcher poll mãi — một lần thử
 *     không được biến thành một đầu việc vĩnh viễn.
 *
 * Có cả flag DRAFT (`includeDrafts`, chỉ ở server): giai đoạn DRAFT là lúc cần
 * thử rule nhất. Kết quả đánh dấu `draft` — SDK HÔM NAY chưa thấy flag đó (§6.7).
 * Rule khớp tra từ CÙNG snapshot, không tra lại theo id ở thời điểm khác.
 */
export async function evaluateForTester(
  flagId: string,
  environmentId: string,
  context: Record<string, unknown>,
): Promise<TesterResult> {
  const flag = await repository.testerTargetOf(prisma, flagId, environmentId);
  if (flag === null) throw new NotFoundError(NOT_FOUND);

  const row = await snapshotRowOf(prisma, environmentId, {
    includeDrafts: true,
  });
  if (row === undefined) throw new NotFoundError(NOT_FOUND);
  const snapshot = snapshotFromRow(row);
  const evaluation = evaluate(prepareSnapshot(snapshot), flag.key, context);

  const entry = snapshot.flags.find((f) => f.key === flag.key);
  const rule =
    entry !== undefined && !("archived" in entry)
      ? entry.rules.find((r) => r.id === evaluation.ruleId)
      : undefined;

  return {
    evaluation,
    ...(rule === undefined
      ? {}
      : {
          rule: { id: rule.id, ruleType: rule.type, priority: rule.priority },
        }),
    configVersion: row.configVersion,
    draft: flag.lifecycleStatus === "DRAFT",
  };
}
