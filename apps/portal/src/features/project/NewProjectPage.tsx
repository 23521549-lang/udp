import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { Info } from "lucide-react";
import { useState } from "react";
import { Icon } from "../../components/Icon";
import { fieldErrorsOf, messageOf } from "../../lib/errors";
import { qk } from "../../lib/query-keys";
import type { PublicProjectWire } from "@udp/shared-types/wire";
import { DomainPanel } from "../domain/DomainPanel";
import { CloudPanel } from "./cloud/CloudPanel";
import { projectApi, type CreateProjectInput } from "./project-api";

const RUNTIMES = [
  { id: "nodejs", label: "Node.js" },
  { id: "python", label: "Python" },
] as const;

/**
 * Wizard tạo project (§10.5): bước 1 tạo project, bước 2 kết nối cloud (Plan #26), bước 3
 * chọn domain (Plan #27).
 *
 * Hai bước sau (xem trước, provisioning) cần endpoint chưa tồn tại ở Service 1 (sổ nợ
 * `portal-preview`, `portal-job-stream`). Trang nói thật điều đó thay vì dựng màn hình giả:
 * project tạo ra đứng ở DRAFT, và flag, segment, rollout, SDK key đều dùng được ngay. Bước
 * cloud và domain bỏ qua được và làm lại ở Cài đặt > Cloud và trang Domain.
 */
export function NewProjectPage() {
  const [created, setCreated] = useState<PublicProjectWire | null>(null);
  const [step, setStep] = useState<"cloud" | "domains">("cloud");
  if (created === null) return <CreateStep onCreated={setCreated} />;
  return step === "cloud" ? (
    <CloudStep project={created} onNext={() => setStep("domains")} />
  ) : (
    <DomainStep project={created} />
  );
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
      <WizardBar step="Bước 2/3: Cloud" />
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

function DomainStep({ project }: { project: PublicProjectWire }) {
  const open = useOpenProject(project);
  const [saved, setSaved] = useState(false);
  return (
    <>
      <WizardBar step="Bước 3/3: Domain" />
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
            onSaved={() => setSaved(true)}
          />
          <div className="form-actions">
            <button
              type="button"
              className={saved ? "btn pri" : "btn"}
              onClick={open}
            >
              {saved ? "Mở project" : "Để sau"}
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
      await queryClient.invalidateQueries({ queryKey: qk.projects() });
      onCreated(data.project);
    },
  });
  const fields = fieldErrorsOf(create.error);

  return (
    <>
      <WizardBar step="Bước 1/3: Project" />
      <div className="scroll">
        <div className="page" style={{ maxWidth: 640 }}>
          <h1 className="title">Tạo project</h1>
          <p className="lead">
            Project sinh sẵn ba environment: dev, staging và production.
          </p>
          <div className="lock">
            <Icon of={Info} />
            <span>
              Bước xem trước và triển khai chưa có trên Portal. Project mới đứng
              ở trạng thái Nháp; flag, segment, rollout và SDK key dùng được
              ngay.
            </span>
          </div>
          <form
            className="form"
            noValidate
            onSubmit={(e) => {
              e.preventDefault();
              create.mutate();
            }}
          >
            <div className="f">
              <label htmlFor="p-name">Tên project</label>
              <input
                id="p-name"
                className="inp"
                required
                maxLength={255}
                value={form.name}
                aria-invalid={fields.name !== undefined}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
              />
              {fields.name !== undefined && (
                <span className="field-error">{fields.name}</span>
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
                  className="inp"
                  type="url"
                  placeholder="https://github.com/org/repo"
                  value={form.repoUrl ?? ""}
                  aria-invalid={fields.repoUrl !== undefined}
                  onChange={(e) =>
                    setForm({ ...form, repoUrl: e.target.value })
                  }
                />
                {fields.repoUrl !== undefined && (
                  <span className="field-error">{fields.repoUrl}</span>
                )}
              </div>
            )}
            <div className="f">
              <label htmlFor="p-runtime">Runtime</label>
              <select
                id="p-runtime"
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
                disabled={create.isPending || form.name.trim() === ""}
              >
                {create.isPending ? "Đang tạo..." : "Tạo project"}
              </button>
            </div>
          </form>
        </div>
      </div>
    </>
  );
}
