import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import { Info } from "lucide-react";
import { useRef, useState } from "react";
import type { NewProjectSearch } from "../../app/router";
import { Icon } from "../../components/Icon";
import { ErrorState, Loading } from "../../components/States";
import { fieldErrorsOf, messageOf } from "../../lib/errors";
import { qk, qkPrefix } from "../../lib/query-keys";
import type { PublicProjectWire } from "@udp/shared-types/wire";
import { DomainPanel } from "../domain/DomainPanel";
import { JobLog } from "../provisioning/JobLog";
import { PreviewPanel } from "../provisioning/PreviewPanel";
import { CloudPanel } from "./cloud/CloudPanel";
import { projectApi, type CreateProjectInput } from "./project-api";

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
        <WizardBar step="Tạo project" />
        <div className="page">
          {detail.isPending ? (
            <Loading />
          ) : (
            <ErrorState
              error={detail.error}
              onRetry={() => void detail.refetch()}
              back={
                <Link to="/app/projects/new" search={{}} className="btn">
                  Tạo project mới
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

function WizardBar({ step }: { step: string }) {
  return (
    <div className="bar">
      <div className="crumbs">
        <Link to="/app/projects">Project</Link>
        <span className="sep">/</span>
        <b>Tạo project</b>
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
  const [saved, setSaved] = useState(false);
  return (
    <>
      <WizardBar step="Bước 2/5: Cloud" />
      <div className="scroll">
        <div className="page" style={{ maxWidth: 760 }}>
          <h1 className="title">Kết nối cloud</h1>
          <p className="lead">
            Project {project.name} đã tạo. Chọn nơi UDP dựng hạ tầng; có thể làm
            sau ở Cài đặt, thẻ Cloud.
          </p>
          <CloudPanel
            projectId={project.id}
            role={project.myRole}
            onSaved={() => setSaved(true)}
          />
          <div className="form-actions">
            <button
              type="button"
              className={saved ? "btn pri" : "btn"}
              onClick={onNext}
            >
              {saved ? "Tiếp tục" : "Để sau"}
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
  const [saved, setSaved] = useState(false);
  return (
    <>
      <WizardBar step="Bước 3/5: Domain" />
      <div className="scroll">
        <div className="page" style={{ maxWidth: 760 }}>
          <h1 className="title">Chọn domain</h1>
          <p className="lead">
            Bật những công cụ hạ tầng project cần. Cấu hình được kiểm trước khi
            lưu; có thể đổi sau ở trang Domain.
          </p>
          <DomainPanel
            projectId={project.id}
            role={project.myRole}
            live={project.status === "ACTIVE"}
            level={2}
            onSaved={() => setSaved(true)}
          />
          <div className="form-actions">
            <button
              type="button"
              className={saved ? "btn pri" : "btn"}
              onClick={onNext}
            >
              {saved ? "Tiếp tục" : "Để sau"}
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
  const open = useOpenProject(project);
  return (
    <>
      <WizardBar step="Bước 4/5: Xem trước" />
      <div className="scroll">
        <div className="page" style={{ maxWidth: 760 }}>
          <h1 className="title">Xem trước và triển khai</h1>
          <p className="lead">
            Chi phí ước tính và thứ tự UDP dựng hạ tầng trên tài khoản cloud của
            bạn. Có thể triển khai sau ở trang Hạ tầng.
          </p>
          <PreviewPanel
            projectId={project.id}
            role={project.myRole}
            onStarted={(job) => onStarted(job.id)}
          />
          <div className="form-actions">
            <button type="button" className="btn" onClick={open}>
              Để sau
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
  const open = useOpenProject(project);
  return (
    <>
      <WizardBar step="Bước 5/5: Triển khai" />
      <div className="scroll">
        <div className="page" style={{ maxWidth: 760 }}>
          <h1 className="title">Đang triển khai</h1>
          <p className="lead">
            Tiến độ cập nhật trực tiếp. Rời trang không dừng việc triển khai;
            theo dõi tiếp ở trang Hạ tầng.
          </p>
          <JobLog projectId={project.id} jobId={jobId} role={project.myRole} />
          <div className="form-actions">
            <button type="button" className="btn pri" onClick={open}>
              Mở project
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
      setClientErrors({ name: "Nhập tên project." });
      nameInput.current?.focus();
      return;
    }
    setClientErrors({});
    create.mutate();
  };

  return (
    <>
      <WizardBar step="Bước 1/5: Project" />
      <div className="scroll">
        <div className="page" style={{ maxWidth: 640 }}>
          <h1 className="title">Tạo project</h1>
          <p className="lead">
            Project sinh sẵn ba environment: dev, staging và production.
          </p>
          <div className="lock">
            <Icon of={Info} />
            <span>
              Project mới đứng ở trạng thái Nháp cho tới khi triển khai; flag,
              segment, rollout và SDK key dùng được ngay.
            </span>
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
              <label htmlFor="p-name">Tên project</label>
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
                Cách tạo
              </span>
              <div className="opts" role="group" aria-labelledby="p-mode">
                <button
                  type="button"
                  aria-pressed={form.creationMode === "CREATE_NEW"}
                  onClick={() =>
                    setForm({ ...form, creationMode: "CREATE_NEW" })
                  }
                >
                  <b>Tạo mới</b>
                  Dựng từ mẫu Golden Path
                </button>
                <button
                  type="button"
                  aria-pressed={form.creationMode === "IMPORT_EXISTING"}
                  onClick={() =>
                    setForm({ ...form, creationMode: "IMPORT_EXISTING" })
                  }
                >
                  <b>Nhập kho có sẵn</b>
                  Dùng repo đã có
                </button>
              </div>
            </div>
            {form.creationMode === "IMPORT_EXISTING" && (
              <div className="f">
                <label htmlFor="p-repo">URL kho mã</label>
                <input
                  id="p-repo"
                  name="repoUrl"
                  className="inp"
                  type="url"
                  inputMode="url"
                  autoComplete="off"
                  spellCheck={false}
                  placeholder="https://github.com/org/repo…"
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
              <label htmlFor="p-runtime">Runtime</label>
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
                Huỷ
              </Link>
              <button
                type="submit"
                className="btn pri"
                disabled={create.isPending}
              >
                {create.isPending ? "Đang tạo…" : "Tạo project"}
              </button>
            </div>
          </form>
        </div>
      </div>
    </>
  );
}
