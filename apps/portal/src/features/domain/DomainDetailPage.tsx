import { useQuery } from "@tanstack/react-query";
import { useParams } from "@tanstack/react-router";
import { CircleAlert, CircleCheck, Info } from "lucide-react";
import { CodeBlock } from "../../components/CodeBlock";
import { Icon } from "../../components/Icon";
import { ErrorState, Loading } from "../../components/States";
import { formatDateTime } from "../../lib/format";
import { qk } from "../../lib/query-keys";
import { ProjectBar } from "../project/ProjectBar";
import { useProjectContext } from "../project/ProjectLayout";
import { CicdPanel } from "./CicdPanel";
import { domainApi } from "./domain-api";
import { DomainActions } from "./DomainActions";
import { domainStatusLabel, driftLabel } from "./domain-labels";

/**
 * Chi tiết một domain (§10.13): trạng thái đã lưu và kết quả quét drift gần nhất — câu
 * "đã trôi" luôn đi kèm CHỖ trôi mà lượt quét ghi lại, không chỉ một huy hiệu. Domain CI/CD
 * thêm bảng webhook (§8.3).
 */
export function DomainDetailPage() {
  const { project } = useProjectContext();
  const { type } = useParams({
    from: "/app/projects/$projectId/domains/$type",
  });
  const domain = useQuery({
    queryKey: qk.domain(project.id, type),
    queryFn: () => domainApi.one(project.id, type),
  });
  const drift = useQuery({
    queryKey: qk.domainDrift(project.id, type),
    queryFn: () => domainApi.drift(project.id, type),
  });

  return (
    <>
      <ProjectBar title={`Domain ${type}`} envScoped={false} />
      <div className="scroll">
        <div className="page">
          <h1 className="title">{type}</h1>
          {domain.isPending && <Loading />}
          {domain.isError && <ErrorState error={domain.error} />}
          {domain.data !== undefined && (
            <dl className="props">
              <dt>Công cụ</dt>
              <dd>{domain.data.domain.selectedTool ?? "Chưa chọn"}</dd>
              <dt>Phiên bản</dt>
              <dd className="mono">
                {domain.data.domain.adapterVersion ?? "–"}
              </dd>
              <dt>Trạng thái</dt>
              <dd>
                {domain.data.domain.status === null
                  ? "Chưa cấu hình"
                  : domainStatusLabel(domain.data.domain.status)}
                {!domain.data.domain.isEnabled && " (đang tắt)"}
              </dd>
              <dt>Cập nhật</dt>
              <dd>
                {domain.data.domain.updatedAt === null
                  ? "–"
                  : formatDateTime(domain.data.domain.updatedAt)}
              </dd>
            </dl>
          )}
          {domain.data !== undefined && (
            <DomainActions type={type} domain={domain.data.domain} />
          )}
          {type === "CICD" &&
            domain.data?.domain.isEnabled === true &&
            domain.data.domain.selectedTool !== null && <CicdPanel />}
          {domain.data?.domain.toolConfig !== null &&
            domain.data?.domain.toolConfig !== undefined && (
              <>
                <h2 className="h2">Cấu hình mong muốn</h2>
                <CodeBlock
                  code={JSON.stringify(domain.data.domain.toolConfig, null, 2)}
                  label="Cấu hình mong muốn"
                />
              </>
            )}

          <h2 className="h2">Drift</h2>
          {drift.isPending && <Loading />}
          {drift.isError && <ErrorState error={drift.error} />}
          {drift.data !== undefined && (
            <div
              className="check-result"
              role="status"
              aria-label="Kết quả drift"
            >
              <span>
                <Icon
                  of={
                    drift.data.drift.verdict === "CLEAN"
                      ? CircleCheck
                      : drift.data.drift.verdict === "NOT_DEPLOYED"
                        ? Info
                        : CircleAlert
                  }
                />{" "}
                {driftLabel(drift.data.drift.verdict)}
              </span>
              {drift.data.drift.message !== null && (
                <CodeBlock code={drift.data.drift.message} label="Chỗ trôi" />
              )}
              {drift.data.drift.at !== null && (
                <span className="c3">
                  Quét lúc {formatDateTime(drift.data.drift.at)}
                </span>
              )}
            </div>
          )}
        </div>
      </div>
    </>
  );
}
