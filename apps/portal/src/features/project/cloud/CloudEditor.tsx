import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  CLOUD_PROVIDERS_WIRE,
  type CloudProviderWire,
} from "@udp/shared-types/cloud-api";
import type { CloudSetupWire } from "@udp/shared-types/wire";
import { TriangleAlert } from "lucide-react";
import { useState } from "react";
import { CodeBlock } from "../../../components/CodeBlock";
import { Icon } from "../../../components/Icon";
import { ErrorState, Loading } from "../../../components/States";
import { toast } from "../../../components/Toast";
import { UnsavedGuard } from "../../../components/UnsavedGuard";
import { useMessages } from "../../../i18n";
import { fieldErrorsOf, messageOf } from "../../../lib/errors";
import { qk } from "../../../lib/query-keys";
import { labelOf } from "../../provisioning/provisioning-labels";
import { cloudApi } from "./cloud-api";
import { buildBody, initialForm, type CloudForm } from "./cloud-form";
import { cloudMessages } from "./cloud.messages";
import { CREDENTIAL_FIELDS, PROVIDER_LABEL } from "./cloud-labels";

type Method = CloudSetupWire["methods"][number];

/**
 * Chọn cloud và cách xác thực, xem đúng khối lệnh cần dán vào cloud của mình (có nút sao
 * chép), rồi nhập và lưu credential. Người chỉ được xem (MAINTAINER) vẫn thấy khối lệnh —
 * họ thường là người làm phần việc bên cloud — nhưng không có ô nhập và nút lưu.
 */
export function CloudEditor({
  projectId,
  canEdit,
  initialProvider,
  onSaved,
}: {
  projectId: string;
  canEdit: boolean;
  /** Cloud đang dùng — mở sẵn đúng nó khi đổi cấu hình */
  initialProvider: CloudProviderWire;
  onSaved?: () => void;
}) {
  const m = useMessages(cloudMessages);
  const queryClient = useQueryClient();
  const [form, setForm] = useState<CloudForm>(() =>
    initialForm(initialProvider),
  );
  const [clientErrors, setClientErrors] = useState<Record<string, string>>({});
  /**
   * Bản nháp theo từng cloud: bấm nhầm sang GCP rồi quay lại AWS không xoá khoá vừa gõ. Chỉ sống
   * trong trang — bí mật không đi vào storage nào.
   */
  const [drafts, setDrafts] = useState<
    Partial<Record<CloudProviderWire, CloudForm>>
  >({});
  const setup = useQuery({
    queryKey: qk.cloudSetup(projectId, form.provider),
    queryFn: () => cloudApi.setup(projectId, form.provider),
  });

  const save = useMutation({
    mutationFn: (body: Parameters<typeof cloudApi.put>[1]) =>
      cloudApi.put(projectId, body),
    onSuccess: (data) => {
      queryClient.setQueryData(qk.cloud(projectId), data);
      // Bí mật không ở lại trong bộ nhớ của trang sau khi đã lưu
      setForm((f) => ({ ...f, fields: {}, keyJson: "" }));
      toast.info(m.editor.saved);
      onSaved?.();
    },
  });

  const serverErrors = Object.fromEntries(
    Object.entries(fieldErrorsOf(save.error)).map(([k, v]) => [
      k.replace(/^credential\./, ""),
      v,
    ]),
  );
  const errors = { ...serverErrors, ...clientErrors };

  const chooseProvider = (provider: CloudProviderWire) => {
    if (provider === form.provider) return;
    setDrafts((d) => ({ ...d, [form.provider]: form }));
    setForm(drafts[provider] ?? initialForm(provider));
    setClientErrors({});
  };
  const submit = () => {
    const built = buildBody(form);
    if (!built.ok) {
      setClientErrors(built.errors);
      // Lỗi đầu tiên nhận focus: người dùng bàn phím không phải đi tìm ô sai
      const first = Object.keys(built.errors)[0];
      if (first !== undefined) {
        requestAnimationFrame(() =>
          document.getElementById(`cloud-${first}`)?.focus(),
        );
      }
      return;
    }
    setClientErrors({});
    save.mutate(built.body);
  };
  // Khoá đã gõ mà chưa lưu: rời trang thì hỏi (gõ lại một khoá bí mật dài là việc không ai muốn)
  const typed =
    form.keyJson.trim() !== "" ||
    Object.values(form.fields).some((v) => v.trim() !== "");

  return (
    <section aria-label={m.editor.label}>
      <UnsavedGuard dirty={typed && !save.isPending} what={m.editor.unsaved} />
      <div className="f">
        <span className="lbl" id="cloud-provider">
          {m.cloud}
        </span>
        <div
          className="opts three"
          role="group"
          aria-labelledby="cloud-provider"
        >
          {CLOUD_PROVIDERS_WIRE.map((p) => (
            <button
              key={p}
              type="button"
              aria-pressed={form.provider === p}
              onClick={() => chooseProvider(p)}
            >
              <b>{PROVIDER_LABEL[p]}</b>
            </button>
          ))}
        </div>
      </div>

      {setup.isPending && <Loading />}
      {setup.isError && (
        <ErrorState error={setup.error} onRetry={() => void setup.refetch()} />
      )}
      {setup.data !== undefined && (
        <SetupBody
          setup={setup.data.setup}
          form={form}
          setForm={setForm}
          canEdit={canEdit}
          errors={errors}
        />
      )}

      {canEdit && setup.data !== undefined && (
        <>
          {save.isError && Object.keys(serverErrors).length === 0 && (
            <p role="alert" className="field-error">
              {messageOf(save.error)}
            </p>
          )}
          <div className="form-actions">
            <button
              type="button"
              className="btn pri"
              disabled={save.isPending}
              onClick={submit}
            >
              {save.isPending ? m.editor.saving : m.editor.save}
            </button>
          </div>
        </>
      )}
    </section>
  );
}

function SetupBody({
  setup,
  form,
  setForm,
  canEdit,
  errors,
}: {
  setup: CloudSetupWire;
  form: CloudForm;
  setForm: (f: CloudForm) => void;
  canEdit: boolean;
  errors: Record<string, string>;
}) {
  const m = useMessages(cloudMessages);
  const method = setup.methods.find((x) => x.authKind === form.authKind);
  return (
    <div className="form">
      <div className="f">
        <span className="lbl" id="cloud-mode">
          {m.editor.mode}
        </span>
        <div className="opts" role="group" aria-labelledby="cloud-mode">
          <button
            type="button"
            aria-pressed={form.mode === "BYOC"}
            onClick={() => setForm({ ...form, mode: "BYOC" })}
          >
            <b>{m.editor.myAccount}</b>
            {m.editor.myAccountHint}
          </button>
          <button
            type="button"
            aria-pressed={form.mode === "MANAGED"}
            disabled={!setup.managed.available}
            onClick={() => setForm({ ...form, mode: "MANAGED" })}
          >
            <b>{m.udpAccount}</b>
            {setup.managed.unavailableReason === null
              ? m.editor.noCredential
              : m.unavailable[setup.managed.unavailableReason]}
          </button>
        </div>
      </div>

      {form.mode === "BYOC" && (
        <MethodPicker setup={setup} form={form} setForm={setForm} />
      )}
      {form.mode === "BYOC" && method !== undefined && (
        <Snippets method={method} />
      )}

      {canEdit && (
        <div className="grid-f">
          <Field
            id="region"
            label={m.editor.region}
            value={form.region}
            error={errors.region}
            onChange={(v) => setForm({ ...form, region: v })}
          />
        </div>
      )}
      {canEdit && form.mode === "BYOC" && (
        <CredentialInputs form={form} setForm={setForm} errors={errors} />
      )}
    </div>
  );
}

function MethodPicker({
  setup,
  form,
  setForm,
}: {
  setup: CloudSetupWire;
  form: CloudForm;
  setForm: (f: CloudForm) => void;
}) {
  const m = useMessages(cloudMessages);
  const chosen = setup.methods.find((x) => x.authKind === form.authKind);
  return (
    <div className="f">
      <span className="lbl" id="cloud-method">
        {m.editor.method}
      </span>
      <div className="opts" role="group" aria-labelledby="cloud-method">
        {setup.methods.map((x) => (
          <button
            key={x.authKind}
            type="button"
            aria-pressed={form.authKind === x.authKind}
            disabled={!x.available}
            onClick={() =>
              setForm({
                ...form,
                authKind: x.authKind,
                fields: {},
                keyJson: "",
              })
            }
          >
            <b>{m.authKind[x.authKind]}</b>
            {x.unavailableReason !== null
              ? m.unavailable[x.unavailableReason]
              : x.federated
                ? m.editor.federatedHint
                : m.editor.staticHint}
          </button>
        ))}
      </div>
      {chosen !== undefined && !chosen.federated && (
        <div className="lock" role="note">
          <Icon of={TriangleAlert} />
          <span>{m.editor.staticNote}</span>
        </div>
      )}
    </div>
  );
}

function Snippets({ method }: { method: Method }) {
  const m = useMessages(cloudMessages);
  return (
    <div className="snips" aria-label={m.editor.snippets}>
      {method.snippets.map((s) => (
        <div key={s.id}>
          <h3>{labelOf(m.snippet, s.id)}</h3>
          <CodeBlock code={s.content} label={labelOf(m.snippet, s.id)} />
        </div>
      ))}
    </div>
  );
}

function CredentialInputs({
  form,
  setForm,
  errors,
}: {
  form: CloudForm;
  setForm: (f: CloudForm) => void;
  errors: Record<string, string>;
}) {
  const m = useMessages(cloudMessages);
  if (form.authKind === "GCP_KEY") {
    return (
      <div className="f">
        <label htmlFor="cloud-keyJson">{m.editor.keyJson}</label>
        <textarea
          id="cloud-keyJson"
          className="inp"
          rows={6}
          autoComplete="off"
          spellCheck={false}
          value={form.keyJson}
          aria-invalid={errors.keyJson !== undefined}
          aria-describedby={
            errors.keyJson === undefined ? undefined : "cloud-keyJson-err"
          }
          onChange={(e) => setForm({ ...form, keyJson: e.target.value })}
        />
        {errors.keyJson !== undefined && (
          <span id="cloud-keyJson-err" className="field-error">
            {errors.keyJson}
          </span>
        )}
      </div>
    );
  }
  return (
    <div className="grid-f">
      {CREDENTIAL_FIELDS[form.authKind].map((f) => (
        <Field
          key={f.key}
          id={f.key}
          label={m.credentialField[f.key]}
          secret={f.secret}
          placeholder={f.placeholder}
          value={form.fields[f.key] ?? ""}
          error={errors[f.key]}
          onChange={(v) =>
            setForm({ ...form, fields: { ...form.fields, [f.key]: v } })
          }
        />
      ))}
    </div>
  );
}

function Field({
  id,
  label,
  value,
  onChange,
  error,
  secret = false,
  placeholder,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (v: string) => void;
  error: string | undefined;
  secret?: boolean | undefined;
  placeholder?: string | undefined;
}) {
  return (
    <div className="f">
      <label htmlFor={`cloud-${id}`}>{label}</label>
      <input
        id={`cloud-${id}`}
        name={id}
        className="inp"
        type={secret ? "password" : "text"}
        /*
         * "new-password", không "off": trình duyệt bỏ qua "off" trên ô mật khẩu và tự điền mật khẩu
         * đăng nhập Portal vào ô khoá bí mật của cloud — một bí mật rò sang chỗ của bí mật khác.
         */
        autoComplete={secret ? "new-password" : "off"}
        spellCheck={false}
        placeholder={placeholder}
        value={value}
        aria-invalid={error !== undefined}
        aria-describedby={error === undefined ? undefined : `cloud-${id}-err`}
        onChange={(e) => onChange(e.target.value)}
      />
      {error !== undefined && (
        <span id={`cloud-${id}-err`} className="field-error">
          {error}
        </span>
      )}
    </div>
  );
}
