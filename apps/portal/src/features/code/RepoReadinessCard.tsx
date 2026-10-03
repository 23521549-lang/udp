import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ErrorState } from "../../components/States";
import { useMessages } from "../../i18n";
import { qk } from "../../lib/query-keys";
import { useProjectContext } from "../project/ProjectLayout";
import { ReadinessKpi } from "./CodePage";
import { codeApi } from "./code-api";
import { codeMessages } from "./code.messages";

/**
 * Thẻ "Sẵn sàng cho flag-level rollout" ở Tổng quan của project Import Existing (§11.2 bước 5): nói
 * NGAY trên dashboard điều còn thiếu, không đợi tới lúc tạo rollout mới nhận 422. Đọc lần quét đã lưu,
 * không quét lại mỗi lần mở trang.
 */
export function RepoReadinessCard() {
  const m = useMessages(codeMessages);
  const { project } = useProjectContext();
  const last = useQuery({
    queryKey: qk.repoScan(project.id),
    queryFn: () => codeApi.lastScan(project.id),
  });
  const link = (
    <Link
      to="/app/projects/$projectId/code"
      params={{ projectId: project.id }}
      className="c3"
    >
      {m.viewCodePage}
    </Link>
  );
  if (last.isPending) {
    return (
      <div className="kpi" aria-label={m.readiness}>
        <div className="c3">…</div>
      </div>
    );
  }
  if (last.isError) return <ErrorState error={last.error} />;
  if (last.data.scan === null) {
    return (
      <div className="kpi" aria-label={m.readiness}>
        <div className="l">{m.readiness}</div>
        <div className="c3">{m.notScanned}</div>

        {link}
      </div>
    );
  }
  return (
    <div>
      <ReadinessKpi scan={last.data.scan} />
      {link}
    </div>
  );
}
