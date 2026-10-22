import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import { Info } from "lucide-react";
import { useRef, useState } from "react";
import type { NewProjectSearch } from "../../app/router";
import { Icon } from "../../components/Icon";
import { InfoTip } from "../../components/InfoTip";
import { ErrorState, Loading } from "../../components/States";
import { useMessages } from "../../i18n";
import { fieldErrorsOf, messageOf } from "../../lib/errors";
import { qk, qkPrefix } from "../../lib/query-keys";
import type { PublicProjectWire } from "@udp/shared-types/wire";
import { DomainPanel } from "../domain/DomainPanel";
import { JobLog } from "../provisioning/JobLog";
import { PreviewPanel } from "../provisioning/PreviewPanel";
import { CloudPanel } from "./cloud/CloudPanel";
import { projectApi, type CreateProjectInput } from "./project-api";
import { projectMessages, type WizardStep } from "./project.messages";

const RUNTIMES = [
  { id: "nodejs", label: "Node.js" },
  { id: "python", label: "Python" },
] as const;

/**
 * Wizard tạo project (§10.5), năm bước: tạo project, kết nối cloud (Plan #26), chọn domain
 * (Plan #27), xem trước chi phí và thứ tự dựng, rồi theo dõi lượt triển khai (Plan #28).
 *
 * Từ bước 2 mọi bước bỏ qua được: project đứng ở DRAFT, flag, segment, rollout, SDK key
 * dùng được ngay, và cloud, domain, triển khai làm lại ở Cài đặt, trang Domain, trang Hạ
 * tầng.
 */
export function NewProjectPage() {
  const m = useMessages(projectMessages);
  const search = useSearch({ from: "/app/projects/new" });
  const navigate = useNavigate();
  const go = (next: NewProjectSearch): void => {
    void navigate({ to: "/app/projects/new", search: next });
  };
  const projectId = search.project;
  const detail = useQuery({
    queryKey: qk.project(projectId ?? ""),
    queryFn: () => projectApi.get(projectId ?? ""),
    enabled: projectId !== undefined,
  });

  if (projectId === undefined) {
    return (
      <CreateStep onCreated={(p) => go({ project: p.id, step: "cloud" })} />
    );
  }
  if (detail.isPending || detail.isError) {
    return (
      <>
        <WizardBar step={m.createProject} />
        <div className="page">
          {detail.isPending ? (
            <Loading />
          ) : (
            <ErrorState
              error={detail.error}
              onRetry={() => void detail.refetch()}
              back={
                <Link to="/app/projects/new" search={{}} className="btn">
                  {m.wizard.createNewProject}
                </Link>
              }
            />
          )}
        </div>
      </>
    );
  }
  const created = detail.data.project;
  if (search.job !== undefined) {
    return <JobStep project={created} jobId={search.job} />;
  }
  switch (search.step ?? "cloud") {
    case "cloud":
      return (
        <CloudStep
          project={created}
          onNext={() => go({ project: created.id, step: "domains" })}
        />
      );
    case "domains":
      return (
        <DomainStep
          project={created}
          onNext={() => go({ project: created.id, step: "preview" })}
        />
      );
    case "preview":
      return (
        <PreviewStep
          project={created}
          onStarted={(jobId) => go({ project: created.id, job: jobId })}
        />
      );
  }
}

function useOpenProject(project: PublicProjectWire) {
  const navigate = useNavigate();
  return () =>
    void navigate({
      to: "/app/projects/$projectId",
      params: { projectId: project.id },
      search: {},
    });
}

/** Năm bước của wizard; ba bước giữa nằm trên URL (`?step=`) nên quay lại được */
const STEPS: readonly WizardStep[] = [
  "project",
  "cloud",
  "domains",
  "preview",
  "deploy",
];
const isUrlStep = (s: WizardStep): s is NonNullable<NewProjectSearch["step"]> =>
  s === "cloud" || s === "domains" || s === "preview";

/**
 * [Plan #58 UX-15] Thanh năm bước (NN/g về wizard): người dùng thấy mình ở đâu, còn bao nhiêu, và bấm một bước đã
 * qua để quay lại. Bước 1 đã tạo project nên không quay về được (quay về là tạo trùng); bước 5 chỉ tới khi bấm Bắt đầu.
 */
function Stepper({
  current,
  projectId,
}: {
  current: WizardStep;
  projectId?: string;
}) {
  const m = useMessages(projectMessages).wizard;
  const at = STEPS.indexOf(current);
  return (
    <nav aria-label={m.steps}>
      <ol className="wz-steps">
        {STEPS.map((s, i) => {
          const label = (
            <>
              <span className="wz-n">{i + 1}</span>
              {m.stepName[s]}
              {i < at && <span className="visually-hidden"> {m.stepDone}</span>}
            </>
          );
          return (
            <li
              key={s}
              className={i < at ? "done" : undefined}
              aria-current={i === at ? "step" : undefined}
            >
              {i < at && projectId !== undefined && isUrlStep(s) ? (
                <Link
                  to="/app/projects/new"
                  search={{ project: projectId, step: s }}
                >
                  {label}
                </Link>
              ) : (
                <span>{label}</span>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

/** Nút Quay lại của một bước giữa: về bước trước, cùng project */
function BackLink({
  projectId,
  to,
}: {
  projectId: string;
  to: NonNullable<NewProjectSearch["step"]>;
}) {
  const m = useMessages(projectMessages).wizard;
  return (
    <Link
      to="/app/projects/new"
      search={{ project: projectId, step: to }}
      className="btn wz-back"
    >
      {m.back}
    </Link>
  );
}

function WizardBar({ step }: { step: string }) {
  const m = useMessages(projectMessages);
  return (
    <div className="bar">
      <div className="crumbs">
        <Link to="/app/projects">{m.projects}</Link>
        <span className="sep">/</span>
        <b>{m.createProject}</b>
        <span className="sep">/</span>
        <span>{step}</span>
      </div>
    </div>
  );
}

function CloudStep({
  project,
  onNext,
}: {
  project: PublicProjectWire;
  onNext: () => void;
}) {
  const m = useMessages(projectMessages).wizard;
  const [saved, setSaved] = useState(false);
  return (
    <>
      <WizardBar step={m.step2} />
      <div className="scroll">
        <div className="page" style={{ maxWidth: 760 }}>
          <Stepper current="cloud" projectId={project.id} />
          <div className="title-row">
            <h1 className="title">{m.cloudTitle}</h1>
            <InfoTip term="byoc" />
          </div>
          <p className="lead">{m.cloudLead(project.name)}</p>
          <CloudPanel
            projectId={project.id}
            role={project.myRole}
            onSaved={() => setSaved(true)}
          />
          <div className="wizard-nav">
            <button
              type="button"
              className={saved ? "btn pri" : "btn"}
              onClick={onNext}
            >
              {saved ? m.next : m.later}
            </button>
          </div>
        </div>
      </div>
    </>
  );
}

function DomainStep({
  project,
  onNext,
}: {
  project: PublicProjectWire;
  onNext: () => void;
}) {
  const m = useMessages(projectMessages).wizard;
  const [saved, setSaved] = useState(false);
  return (
    <>
      <WizardBar step={m.step3} />
      <div className="scroll">
        <div className="page" style={{ maxWidth: 760 }}>
          <Stepper current="domains" projectId={project.id} />
          <h1 className="title">{m.domainTitle}</h1>
          <p className="lead">{m.domainLead}</p>
          <DomainPanel
            projectId={project.id}
            role={project.myRole}
            live={project.status === "ACTIVE"}
            level={2}
            onSaved={() => setSaved(true)}
          />
          <div className="wizard-nav">
            <BackLink projectId={project.id} to="cloud" />
            <button
              type="button"
              className={saved ? "btn pri" : "btn"}
              onClick={onNext}
            >
              {saved ? m.next : m.later}
            </button>
          </div>
        </div>
      </div>
    </>
  );
}

function PreviewStep({
  project,
  onStarted,
}: {
  project: PublicProjectWire;
  onStarted: (jobId: string) => void;
}) {
  const m = useMessages(projectMessages).wizard;
  const open = useOpenProject(project);
  return (
    <>
      <WizardBar step={m.step4} />
      <div className="scroll">
        <div className="page" style={{ maxWidth: 760 }}>
          <Stepper current="preview" projectId={project.id} />
          <div className="title-row">
            <h1 className="title">{m.previewTitle}</h1>
            <InfoTip term="provisioning" />
          </div>
          <p className="lead">{m.previewLead}</p>
          <PreviewPanel
            projectId={project.id}
            role={project.myRole}
            onStarted={(job) => onStarted(job.id)}
          />
          <div className="wizard-nav">
            <BackLink projectId={project.id} to="domains" />
            <button type="button" className="btn" onClick={open}>
              {m.later}
            </button>
          </div>
        </div>
      </div>
    </>
  );
}

function JobStep({
  project,
  jobId,
}: {
  project: PublicProjectWire;
  jobId: string;
}) {
  const m = useMessages(projectMessages).wizard;
  const open = useOpenProject(project);
  return (
    <>
      <WizardBar step={m.step5} />
      <div className="scroll">
        <div className="page" style={{ maxWidth: 760 }}>
          <Stepper current="deploy" projectId={project.id} />
          <h1 className="title">{m.jobTitle}</h1>
          <p className="lead">{m.jobLead}</p>
          <JobLog projectId={project.id} jobId={jobId} role={project.myRole} />
          <div className="wizard-nav">
            <button type="button" className="btn pri" onClick={open}>
              {m.openProject}
            </button>
          </div>
        </div>
      </div>
    </>
  );
}

function CreateStep({
  onCreated,
}: {
  onCreated: (project: PublicProjectWire) => void;
}) {
  const t = useMessages(projectMessages);
  const m = t.wizard;
  const queryClient = useQueryClient();
  const [form, setForm] = useState<CreateProjectInput>({
    name: "",
    creationMode: "CREATE_NEW",
    languageRuntime: "nodejs",
  });

  const create = useMutation({
    mutationFn: () => {
      const body: CreateProjectInput =
        form.creationMode === "IMPORT_EXISTING"
          ? form
          : {
              name: form.name,
              creationMode: form.creationMode,
              languageRuntime: form.languageRuntime,
            };
      return projectApi.create(body);
    },
    onSuccess: async (data) => {
      queryClient.setQueryData(qk.project(data.project.id), data);
      await queryClient.invalidateQueries({ queryKey: qkPrefix.projectsAll() });
      onCreated(data.project);
    },
  });
  /*
   * Nút "Tạo" không bị khoá trước khi gửi (Web Interface Guidelines): bấm với tên trống thì lỗi hiện
   * ngay dưới ô và ô nhận focus — một nút xám không nói vì sao nó xám.
   */
  const [clientErrors, setClientErrors] = useState<Record<string, string>>({});
  const nameInput = useRef<HTMLInputElement>(null);
  const fields = { ...fieldErrorsOf(create.error), ...clientErrors };
  const submit = (): void => {
    if (form.name.trim() === "") {
      setClientErrors({ name: m.nameRequired });
      nameInput.current?.focus();
      return;
    }
    setClientErrors({});
    create.mutate();
  };

  return (
    <>
      <WizardBar step={m.step1} />
      <div className="scroll">
        <div className="page" style={{ maxWidth: 640 }}>
          <Stepper current="project" />
          <h1 className="title">{t.createProject}</h1>
          <p className="lead">
            {m.createLead}
            <InfoTip term="environment" />
          </p>
          <div className="lock">
            <Icon of={Info} />
            <span>{m.draftNote}</span>
          </div>
          <form
            className="form"
            noValidate
            onSubmit={(e) => {
              e.preventDefault();
              submit();
            }}
          >
            <div className="f">
              <label htmlFor="p-name">{m.name}</label>
              <input
                ref={nameInput}
                id="p-name"
                name="name"
                className="inp"
                required
                maxLength={255}
                autoComplete="off"
                spellCheck={false}
                value={form.name}
                aria-invalid={fields.name !== undefined}
                aria-describedby={
                  fields.name === undefined ? undefined : "p-name-err"
                }
                onChange={(e) => setForm({ ...form, name: e.target.value })}
              />
              {fields.name !== undefined && (
                <span id="p-name-err" className="field-error">
                  {fields.name}
                </span>
              )}
            </div>
            <div className="f">
              <span className="lbl" id="p-mode">
                {m.mode}
              </span>
              <div className="opts" role="group" aria-labelledby="p-mode">
                <button
                  type="button"
                  aria-pressed={form.creationMode === "CREATE_NEW"}
                  onClick={() =>
                    setForm({ ...form, creationMode: "CREATE_NEW" })
                  }
                >
                  <b>{m.createNew}</b>
                  {m.createNewHint}
                </button>
                <button
                  type="button"
                  aria-pressed={form.creationMode === "IMPORT_EXISTING"}
                  onClick={() =>
                    setForm({ ...form, creationMode: "IMPORT_EXISTING" })
                  }
                >
                  <b>{m.importExisting}</b>
                  {m.importExistingHint}
                </button>
              </div>
            </div>
            {form.creationMode === "IMPORT_EXISTING" && (
              <div className="f">
                <label htmlFor="p-repo">{m.repoUrl}</label>
                <input
                  id="p-repo"
                  name="repoUrl"
                  className="inp"
                  type="url"
                  inputMode="url"
                  autoComplete="off"
                  spellCheck={false}
                  placeholder={m.repoUrlPlaceholder}
                  value={form.repoUrl ?? ""}
                  aria-invalid={fields.repoUrl !== undefined}
                  aria-describedby={
                    fields.repoUrl === undefined ? undefined : "p-repo-err"
                  }
                  onChange={(e) =>
                    setForm({ ...form, repoUrl: e.target.value })
                  }
                />
                {fields.repoUrl !== undefined && (
                  <span id="p-repo-err" className="field-error">
                    {fields.repoUrl}
                  </span>
                )}
              </div>
            )}
            <div className="f">
              <label htmlFor="p-runtime">{m.runtime}</label>
              <select
                id="p-runtime"
                name="languageRuntime"
                className="sel"
                value={form.languageRuntime}
                onChange={(e) =>
                  setForm({ ...form, languageRuntime: e.target.value })
                }
              >
                {RUNTIMES.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.label}
                  </option>
                ))}
              </select>
            </div>
            {create.isError && Object.keys(fields).length === 0 && (
              <p role="alert" className="field-error">
                {messageOf(create.error)}
              </p>
            )}
            <div className="form-actions">
              <Link to="/app/projects" className="btn">
                {t.cancel}
              </Link>
              <button
                type="submit"
                className="btn pri"
                disabled={create.isPending}
              >
                {create.isPending ? t.creating : m.createAndContinue}
              </button>
            </div>
          </form>
        </div>
      </div>
    </>
  );
}
