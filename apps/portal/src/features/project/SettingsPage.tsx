import { useNavigate, useSearch } from "@tanstack/react-router";

import type { SettingsSearch } from "../../app/router";
import { useMessages } from "../../i18n";
import { ProjectBar } from "./ProjectBar";
import { CloudPanel } from "./cloud/CloudPanel";
import { useProjectContext } from "./ProjectLayout";
import { AuditTab } from "./settings/AuditTab";
import { EnvironmentsTab } from "./settings/EnvironmentsTab";
import { MembersTab } from "./settings/MembersTab";
import { ProjectTab } from "./settings/ProjectTab";
import { SdkKeysTab } from "./settings/SdkKeysTab";
import { PageHead } from "../../components/PageHead";
import { projectMessages } from "./project.messages";

type Tab = NonNullable<SettingsSearch["tab"]>;
/** Thứ tự tab; nhãn ở `projectMessages.settings.tab` */
const TABS: readonly Tab[] = [
  "keys",
  "environments",
  "members",
  "audit",
  "cloud",
  "project",
];

export function SettingsPage() {
  const m = useMessages(projectMessages).settings;
  const search = useSearch({ from: "/app/projects/$projectId/settings" });
  const navigate = useNavigate();
  const tab: Tab = search.tab ?? "keys";
  const { project } = useProjectContext();

  return (
    <>
      <ProjectBar title={m.title} envScoped={tab === "keys"} />
      <div className="scroll">
        <PageHead title={m.title} lead={m.lead} />
        <div className="page">
          <div className="envtabs" role="tablist" aria-label={m.sections}>
            {TABS.map((t) => (
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
                {m.tab[t]}
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
