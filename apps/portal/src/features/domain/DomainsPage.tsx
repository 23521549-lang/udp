import { Blocks } from "lucide-react";
import { Icon } from "../../components/Icon";
import { ProjectBar } from "../project/ProjectBar";
import { useProjectContext } from "../project/ProjectLayout";
import { DomainPanel } from "./DomainPanel";

/** Trang Domain của project (§10.7) — domain là của cả project, không theo env */
export function DomainsPage() {
  const { project } = useProjectContext();
  return (
    <>
      <ProjectBar title="Domain" envScoped={false} />
      <div className="scroll">
        <div className="mhead">
          <span className="tile xl">
            <Icon of={Blocks} size={21} />
          </span>
          <div>
            <h1>Domain</h1>
            <p>
              Công cụ hạ tầng của project. Danh sách dựng từ adapter mà máy chủ
              nạp được, và cấu hình được kiểm trước khi lưu.
            </p>
          </div>
        </div>
        <div className="page">
          <DomainPanel projectId={project.id} role={project.myRole} />
        </div>
      </div>
    </>
  );
}
