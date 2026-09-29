import { ProjectBar } from "../project/ProjectBar";
import { useProjectContext } from "../project/ProjectLayout";
import { DomainPanel } from "./DomainPanel";
import { PageHead } from "../../components/PageHead";
import { useMessages } from "../../i18n";
import { domainMessages } from "./domain.messages";

/** Trang Domain của project (§10.7) — domain là của cả project, không theo env */
export function DomainsPage() {
  const { project } = useProjectContext();
  const m = useMessages(domainMessages).page;
  return (
    <>
      <ProjectBar title={m.title} envScoped={false} />
      <div className="scroll">
        <PageHead title={m.title} lead={m.lead} />
        <div className="page">
          <DomainPanel
            projectId={project.id}
            role={project.myRole}
            live={project.status === "ACTIVE"}
            level={2}
          />
        </div>
      </div>
    </>
  );
}
