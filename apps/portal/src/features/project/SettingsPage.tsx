import { useNavigate, useSearch } from "@tanstack/react-router";

import type { SettingsSearch } from "../../app/router";
import { ProjectBar } from "./ProjectBar";
import { CloudPanel } from "./cloud/CloudPanel";
import { useProjectContext } from "./ProjectLayout";
import { AuditTab } from "./settings/AuditTab";
import { EnvironmentsTab } from "./settings/EnvironmentsTab";
import { MembersTab } from "./settings/MembersTab";
import { ProjectTab } from "./settings/ProjectTab";
import { SdkKeysTab } from "./settings/SdkKeysTab";
import { PageHead } from "../../components/PageHead";

type Tab = NonNullable<SettingsSearch["tab"]>;
const TAB_LABEL: Record<Tab, string> = {
  keys: "SDK key",
  environments: "Environment",
  members: "Thành viên",
  audit: "Nhật ký",
  cloud: "Cloud",
  project: "Project",
};

export function SettingsPage() {
  const search = useSearch({ from: "/app/projects/$projectId/settings" });
  const navigate = useNavigate();
  const tab: Tab = search.tab ?? "keys";
  const { project } = useProjectContext();

  return (
    <>
      <ProjectBar title="Cài đặt" envScoped={tab === "keys"} />
      <div className="scroll">
        <PageHead
          title="Cài đặt"
          lead="SDK key, environment, thành viên, nhật ký, cloud và trần tài nguyên."
        />
        <div className="page">
          <div className="envtabs" role="tablist" aria-label="Mục cài đặt">
            {(Object.keys(TAB_LABEL) as Tab[]).map((t) => (
              <button
                key={t}
                type="button"
                role="tab"
                aria-selected={t === tab}
                onClick={() =>
                  void navigate({
                    to: ".",
                    search: (prev: Record<string, unknown>) => ({
                      ...prev,
                      tab: t,
                    }),
                  })
                }
              >
                {TAB_LABEL[t]}
              </button>
            ))}
          </div>
          {tab === "keys" && <SdkKeysTab />}
          {tab === "environments" && <EnvironmentsTab />}
          {tab === "members" && <MembersTab />}
          {tab === "audit" && <AuditTab />}
          {tab === "cloud" && (
            <CloudPanel projectId={project.id} role={project.myRole} />
          )}
          {tab === "project" && <ProjectTab />}
        </div>
      </div>
    </>
  );
}
