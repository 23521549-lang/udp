import type { DoraWire } from "@udp/shared-types/wire";
import { formatDuration, formatNumber, formatPercent } from "../../lib/format";

/**
 * Bốn chỉ số DORA (§2.2) kèm cỡ mẫu — trang Deploy và phần tóm tắt của trang Giám sát dùng chung.
 * Chưa có sự kiện deploy thì nói thật là chưa có số, không hiện 0.
 */
export function DoraCards({ dora }: { dora: DoraWire }) {
  const noDeploys = dora.changeFailureRate.total === 0;
  return (
    <>
      <div className="stat" aria-label="Chỉ số DORA">
        <div>
          <div className="l">Tần suất deploy</div>
          <div className="v num">
            {noDeploys
              ? "–"
              : formatNumber(
                  Math.round(dora.deploymentFrequencyPerDay * 100) / 100,
                )}
            <small>/ngày</small>
          </div>
          <div className="c3">{dora.deployments} lần thành công</div>
        </div>
        <div>
          <div className="l">Lead time</div>
          <div className="v num">
            {formatDuration(dora.leadTimeSeconds.median)}
          </div>
          <div className="c3">{dora.leadTimeSeconds.samples} mẫu có commit</div>
        </div>
        <div>
          <div className="l">Tỉ lệ thay đổi lỗi</div>
          <div className="v num">
            {dora.changeFailureRate.value === null
              ? "–"
              : formatPercent(dora.changeFailureRate.value * 100)}
          </div>
          <div className="c3">
            {dora.changeFailureRate.failed}/{dora.changeFailureRate.total}{" "}
            deployment
          </div>
        </div>
        <div>
          <div className="l">Thời gian khôi phục</div>
          <div className="v num">
            {formatDuration(dora.recoveryTimeSeconds.median)}
          </div>
          <div className="c3">
            {dora.recoveryTimeSeconds.samples} lần khôi phục
          </div>
        </div>
      </div>
      <p className="c3">
        Rollback trong {dora.window.days} ngày: {dora.rollbacks.auto} tự động
        (hệ thống canary), {dora.rollbacks.manual} thủ công.
        {noDeploys &&
          " Chưa có sự kiện deploy nào từ CI/CD nên bốn chỉ số trên chưa có số."}
      </p>
    </>
  );
}
