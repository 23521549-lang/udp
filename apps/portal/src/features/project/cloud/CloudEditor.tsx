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
import { fieldErrorsOf, messageOf } from "../../../lib/errors";
import { qk } from "../../../lib/query-keys";
import { cloudApi } from "./cloud-api";
import { buildBody, initialForm, type CloudForm } from "./cloud-form";
import {
  AUTH_KIND_LABEL,
  CREDENTIAL_FIELDS,
  PROVIDER_LABEL,
  SNIPPET_TITLE,
  UNAVAILABLE_REASON,
} from "./cloud-labels";

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
  const queryClient = useQueryClient();
  const [form, setForm] = useState<CloudForm>(() =>
    initialForm(initialProvider),
  );
  const [clientErrors, setClientErrors] = useState<Record<string, string>>({});
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
      toast.info("Đã lưu cấu hình cloud");
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
    setForm(initialForm(provider));
    setClientErrors({});
  };
  const submit = () => {
    const built = buildBody(form);
    if (!built.ok) {
      setClientErrors(built.errors);
      return;
    }
    setClientErrors({});
    save.mutate(built.body);
  };

  return (
    <section aria-label="Cấu hình cloud">
      <div className="f">
        <span className="lbl" id="cloud-provider">
          Cloud
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
      {setup.isError && <ErrorState error={setup.error} />}
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
              {save.isPending ? "Đang lưu..." : "Lưu cấu hình cloud"}
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
  const method = setup.methods.find((m) => m.authKind === form.authKind);
  return (
    <div className="form">
      <div className="f">
        <span className="lbl" id="cloud-mode">
          Chạy trong tài khoản nào
        </span>
        <div className="opts" role="group" aria-labelledby="cloud-mode">
          <button
            type="button"
            aria-pressed={form.mode === "BYOC"}
            onClick={() => setForm({ ...form, mode: "BYOC" })}
          >
            <b>Tài khoản của tôi</b>
            UDP dựng hạ tầng trong cloud của bạn
          </button>
          <button
            type="button"
            aria-pressed={form.mode === "MANAGED"}
            disabled={!setup.managed.available}
            onClick={() => setForm({ ...form, mode: "MANAGED" })}
          >
            <b>Tài khoản của UDP</b>
            {setup.managed.unavailableReason === null
              ? "Không cần nhập credential"
              : UNAVAILABLE_REASON[setup.managed.unavailableReason]}
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
            label="Region"
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
  const chosen = setup.methods.find((m) => m.authKind === form.authKind);
  return (
    <div className="f">
      <span className="lbl" id="cloud-method">
        Cách xác thực
      </span>
      <div className="opts" role="group" aria-labelledby="cloud-method">
        {setup.methods.map((m) => (
          <button
            key={m.authKind}
            type="button"
            aria-pressed={form.authKind === m.authKind}
            disabled={!m.available}
            onClick={() =>
              setForm({
                ...form,
                authKind: m.authKind,
                fields: {},
                keyJson: "",
              })
            }
          >
            <b>{AUTH_KIND_LABEL[m.authKind]}</b>
            {m.unavailableReason !== null
              ? UNAVAILABLE_REASON[m.unavailableReason]
              : m.federated
                ? "Khuyến nghị: UDP không giữ bí mật nào của bạn"
                : "Khoá dài hạn, chỉ dùng khi không có cách khác"}
          </button>
        ))}
      </div>
      {chosen !== undefined && !chosen.federated && (
        <div className="lock" role="note">
          <Icon of={TriangleAlert} />
          <span>
            Khoá dài hạn sống tới khi bạn tự thu hồi. UDP mã hoá nó khi lưu và
            chỉ giải mã trong vài phút mỗi lần dùng.
          </span>
        </div>
      )}
    </div>
  );
}

function Snippets({ method }: { method: Method }) {
  return (
    <div className="snips" aria-label="Việc cần làm bên cloud">
      {method.snippets.map((s) => (
        <div key={s.id}>
          <h4>{SNIPPET_TITLE[s.id] ?? s.id}</h4>
          <CodeBlock code={s.content} label={SNIPPET_TITLE[s.id] ?? s.id} />
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
  if (form.authKind === "GCP_KEY") {
    return (
      <div className="f">
        <label htmlFor="cloud-keyJson">Khoá JSON của service account</label>
        <textarea
          id="cloud-keyJson"
          className="inp"
          rows={6}
          autoComplete="off"
          spellCheck={false}
          value={form.keyJson}
          aria-invalid={errors.keyJson !== undefined}
          onChange={(e) => setForm({ ...form, keyJson: e.target.value })}
        />
        {errors.keyJson !== undefined && (
          <span className="field-error">{errors.keyJson}</span>
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
          label={f.label}
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
        className="inp"
        type={secret ? "password" : "text"}
        autoComplete="off"
        placeholder={placeholder}
        value={value}
        aria-invalid={error !== undefined}
        onChange={(e) => onChange(e.target.value)}
      />
      {error !== undefined && <span className="field-error">{error}</span>}
    </div>
  );
}
