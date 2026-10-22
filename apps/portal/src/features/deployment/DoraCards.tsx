import type { DoraWire } from "@udp/shared-types/wire";
import { useMessages } from "../../i18n";
import { formatDuration, formatNumber, formatPercent } from "../../lib/format";
import { deploymentMessages } from "./deployment.messages";

/**
 * Bốn chỉ số DORA (§2.2) kèm cỡ mẫu — trang Deploy và phần tóm tắt của trang Giám sát dùng chung.
 * Chưa có sự kiện deploy thì nói thật là chưa có số, không hiện 0.
 */
export function DoraCards({ dora }: { dora: DoraWire }) {
  const m = useMessages(deploymentMessages).dora;
  const noDeploys = dora.changeFailureRate.total === 0;
  return (
    <>
      <div className="stat" aria-label={m.label}>
        <div>
          <div className="l">{m.frequency}</div>
          <div className="v num">
            {noDeploys
              ? "–"
              : formatNumber(
                  Math.round(dora.deploymentFrequencyPerDay * 100) / 100,
                )}
            <small>{m.perDay}</small>
          </div>
          <div className="c3">{m.successes(dora.deployments)}</div>
        </div>
        <div>
          <div className="l">{m.leadTime}</div>
          <div className="v num">
            {formatDuration(dora.leadTimeSeconds.median)}
          </div>
          <div className="c3">
            {m.leadSamples(dora.leadTimeSeconds.samples)}
          </div>
        </div>
        <div>
          <div className="l">{m.failureRate}</div>
          <div className="v num">
            {dora.changeFailureRate.value === null
              ? "–"
              : formatPercent(dora.changeFailureRate.value * 100)}
          </div>
          <div className="c3">
            {m.failures(
              dora.changeFailureRate.failed,
              dora.changeFailureRate.total,
            )}
          </div>
        </div>
        <div>
          <div className="l">{m.recovery}</div>
          <div className="v num">
            {formatDuration(dora.recoveryTimeSeconds.median)}
          </div>
          <div className="c3">
            {m.recoveries(dora.recoveryTimeSeconds.samples)}
          </div>
        </div>
      </div>
      <p className="c3">
        {m.rollbacks(
          dora.window.days,
          dora.rollbacks.auto,
          dora.rollbacks.manual,
        )}
        {noDeploys && m.noDeploys}
      </p>
    </>
  );
}
