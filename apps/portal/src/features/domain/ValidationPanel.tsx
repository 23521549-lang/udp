import { CAPABILITY_IDS, type CapabilityId } from "@udp/shared-types";
import type { DomainValidationWire } from "@udp/shared-types/wire";
import { CircleAlert, CircleCheck, Info } from "lucide-react";
import { Icon } from "../../components/Icon";
import { InfoTip } from "../../components/InfoTip";
import { useMessages } from "../../i18n";
import { issueText } from "./domain-labels";
import { domainMessages } from "./domain.messages";

/** Lỗi nói về capability: kèm lời giải thích của từ đó */
const CAPABILITY_ISSUES: ReadonlySet<string> = new Set([
  "MISSING_CAPABILITY",
  "MISSING_ANY_OF",
  "AMBIGUOUS_PROVIDER",
]);

/**
 * Kết quả kiểm trạng thái đích (§5.3 bảng thông báo, §10.12): mỗi lỗi là một câu có hành
 * động — nút "Bật …" cho MISSING_CAPABILITY, "Đổi sang …" cho CLOUD_MISMATCH, danh sách chọn
 * cho AMBIGUOUS_PROVIDER — và thứ tự triển khai khi hợp lệ.
 */
export function ValidationPanel({
  validation,
  nameOf,
  canEdit,
  onEnable,
  onChoose,
}: {
  validation: DomainValidationWire;
  nameOf: (key: string) => string;
  canEdit: boolean;
  onEnable: (domainType: string, toolId: string) => void;
  onChoose: (capabilityId: CapabilityId, providerToolId: string) => void;
}) {
  const m = useMessages(domainMessages).validation;
  return (
    <section className="check-result" aria-label={m.label} role="status">
      {validation.valid ? (
        <span>
          <Icon of={CircleCheck} /> {m.valid}
        </span>
      ) : (
        validation.errors.map((issue) => {
          const action = issue.suggestedAction;
          const ambiguousCap =
            issue.code === "AMBIGUOUS_PROVIDER"
              ? CAPABILITY_IDS.find((c) => c === issue.subject)
              : undefined;
          return (
            <div key={`${issue.code}-${issue.subject}`}>
              <span>
                <Icon of={CircleAlert} /> {issueText(issue, nameOf)}
                {/* [Plan #58 UX-19] "capability" là từ lạ: giải thích ngay tại câu lỗi dùng nó */}
                {CAPABILITY_ISSUES.has(issue.code) && (
                  <InfoTip term="capability" />
                )}
              </span>{" "}
              {canEdit &&
                (action?.type === "ENABLE_DOMAIN" ||
                  action?.type === "SWITCH_TOOL") &&
                action.toolId !== undefined && (
                  <button
                    type="button"
                    className="btn"
                    onClick={() =>
                      onEnable(action.domainType, action.toolId ?? "")
                    }
                  >
                    {action.type === "SWITCH_TOOL"
                      ? m.switchTo(action.toolId)
                      : m.enable(action.toolId)}
                  </button>
                )}
              {canEdit && ambiguousCap !== undefined && (
                <select
                  className="sel"
                  aria-label={m.sourceFor(issue.subject)}
                  defaultValue=""
                  onChange={(e) => onChoose(ambiguousCap, e.target.value)}
                >
                  <option value="" disabled>
                    {m.chooseSource}
                  </option>
                  {issue.detail.map((key) => (
                    <option key={key} value={key}>
                      {nameOf(key)}
                    </option>
                  ))}
                </select>
              )}
            </div>
          );
        })
      )}
      {validation.warnings.map((w) => (
        <span key={`${w.subject}-${w.detail.join()}`}>
          <Icon of={Info} /> {issueText(w, nameOf)}
        </span>
      ))}
      {validation.valid &&
        validation.deployOrder !== null &&
        validation.deployOrder.length > 0 && (
          <div>
            <span className="lbl">{m.deployOrder}</span>
            <ol>
              {validation.deployOrder.map((tier) => (
                <li key={tier.join()}>{tier.map(nameOf).join(", ")}</li>
              ))}
            </ol>
          </div>
        )}
    </section>
  );
}
