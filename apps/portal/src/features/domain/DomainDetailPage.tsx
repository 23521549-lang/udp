import { useQuery } from "@tanstack/react-query";
import { useParams } from "@tanstack/react-router";
import { CircleAlert, CircleCheck, Info } from "lucide-react";
import { CodeBlock } from "../../components/CodeBlock";
import { Icon } from "../../components/Icon";
import { ErrorState, Loading } from "../../components/States";
import { useMessages } from "../../i18n";
import { formatDateTime } from "../../lib/format";
import { qk } from "../../lib/query-keys";
import { ProjectBar } from "../project/ProjectBar";
import { useProjectContext } from "../project/ProjectLayout";
import { CicdPanel } from "./CicdPanel";
import { domainApi } from "./domain-api";
import { DomainActions } from "./DomainActions";
import { InfoTip } from "../../components/InfoTip";
import {
  domainName,
  domainPurpose,
  domainStatusLabel,
  driftLabel,
} from "./domain-labels";
import { domainMessages } from "./domain.messages";

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
  const m = useMessages(domainMessages).detail;
  // [Plan #58 UX-7] Tên đọc được ("GitOps") ở tiêu đề và breadcrumb, không phải mã GITOPS trên URL
  const name = domainName(type);
  const purpose = domainPurpose(type);

  return (
    <>
      <ProjectBar title={m.title(name)} envScoped={false} />
      <div className="scroll">
        <div className="page">
          <h1 className="title">{name}</h1>
          {purpose !== undefined && <p className="lead">{purpose}</p>}
          {domain.isPending && <Loading />}
          {domain.isError && <ErrorState error={domain.error} />}
          {domain.data !== undefined && (
            <dl className="props">
              <dt>{m.tool}</dt>
              <dd>{domain.data.domain.selectedTool ?? m.noTool}</dd>
              <dt>{m.version}</dt>
              <dd className="mono">
                {domain.data.domain.adapterVersion ?? "–"}
              </dd>
              <dt>{m.status}</dt>
              <dd>
                {domain.data.domain.status === null
                  ? m.notConfigured
                  : domainStatusLabel(domain.data.domain.status)}
                {!domain.data.domain.isEnabled && m.disabled}
              </dd>
              <dt>{m.updated}</dt>
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
                <h2 className="h2">{m.desired}</h2>
                <CodeBlock
                  code={JSON.stringify(domain.data.domain.toolConfig, null, 2)}
                  label={m.desired}
                />
              </>
            )}

          <div className="sect">
            <h2>{m.drift}</h2>
            <InfoTip term="drift" />
          </div>
          {drift.isPending && <Loading />}
          {drift.isError && <ErrorState error={drift.error} />}
          {drift.data !== undefined && (
            <div
              className="check-result"
              role="status"
              aria-label={m.driftResult}
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
                <CodeBlock code={drift.data.drift.message} label={m.driftAt} />
              )}
              {drift.data.drift.at !== null && (
                <span className="c3">
                  {m.scannedAt(formatDateTime(drift.data.drift.at))}
                </span>
              )}
            </div>
          )}
        </div>
      </div>
    </>
  );
}
