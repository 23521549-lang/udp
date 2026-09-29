import { ProjectBar } from "../project/ProjectBar";
import { useProjectContext } from "../project/ProjectLayout";
import { DomainPanel } from "./DomainPanel";
import { PageHead } from "../../components/PageHead";

/** Trang Domain của project (§10.7) — domain là của cả project, không theo env */
export function DomainsPage() {
  const { project } = useProjectContext();
  return (
    <>
      <ProjectBar title="Domain" envScoped={false} />
      <div className="scroll">
        <PageHead
          title="Domain"
          lead="Công cụ hạ tầng của project. Danh sách dựng từ adapter mà máy chủ nạp được, và cấu hình được kiểm trước khi lưu."
        />
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
