import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  CLOUD_PROVIDERS_WIRE,
  type CloudProviderWire,
} from "@udp/shared-types/cloud-api";
import type { CloudSetupWire } from "@udp/shared-types/wire";
import { ExternalLink, TriangleAlert } from "lucide-react";
import { useState } from "react";
import { CodeBlock } from "../../../components/CodeBlock";
import { Field as FormField } from "../../../components/Field";
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
import {
  CONSOLE_URL,
  CREDENTIAL_FIELDS,
  PROVIDER_LABEL,
  REGIONS,
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
      {/*
       * [Plan #58 UX-16] Chỉ một lựa chọn dùng được (máy chủ tắt MANAGED, như bản free) thì không hỏi: một nút bị khoá
       * chỉ làm người mới phân vân. Có MANAGED thì hai lựa chọn như cũ.
       */}
      {setup.managed.available && (
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
              onClick={() => setForm({ ...form, mode: "MANAGED" })}
            >
              <b>{m.udpAccount}</b>
              {m.editor.noCredential}
            </button>
          </div>
        </div>
      )}

      {form.mode === "BYOC" && (
        <MethodPicker setup={setup} form={form} setForm={setForm} />
      )}
      {form.mode === "BYOC" && method !== undefined && (
        <Snippets method={method} provider={form.provider} canEdit={canEdit} />
      )}

      {canEdit && (
        <div className="grid-f">
          <RegionField
            key={form.provider}
            provider={form.provider}
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

/** Câu theo `id` của khối lệnh; id lạ (máy chủ mới hơn Portal) ⇒ không có câu */
const textOf = (
  table: Readonly<Record<string, string>>,
  id: string,
): string | undefined => table[id];

/** Giá trị của lựa chọn "Region khác": không phải mã region nào */
const OTHER_REGION = "";

/**
 * [Plan #58 UX-16] Region chọn từ danh sách của cloud đang chọn; "Region khác" mở ô gõ mã (máy chủ chỉ kiểm định
 * dạng, nên mã mới của cloud vẫn dùng được). Lỗi gắn vào ô đang dùng, và ô đó mang id `cloud-region` để nút Lưu
 * đưa focus tới đúng nó.
 */
function RegionField({
  provider,
  value,
  error,
  onChange,
}: {
  provider: CloudProviderWire;
  value: string;
  error: string | undefined;
  onChange: (v: string) => void;
}) {
  const m = useMessages(cloudMessages).editor;
  const regions = REGIONS[provider];
  const [custom, setCustom] = useState(
    () => !regions.some((r) => r.id === value),
  );
  return (
    <>
      <FormField
        id={custom ? "cloud-region-pick" : "cloud-region"}
        label={m.region}
        hint={m.regionHint}
        error={custom ? undefined : error}
      >
        {(p) => (
          <select
            {...p}
            name="region"
            className="sel"
            value={custom ? OTHER_REGION : value}
            onChange={(e) => {
              const next = e.target.value;
              setCustom(next === OTHER_REGION);
              onChange(next);
            }}
          >
            {regions.map((r) => (
              <option key={r.id} value={r.id}>
                {m.regionOption(r.city, r.id)}
              </option>
            ))}
            <option value={OTHER_REGION}>{m.regionOther}</option>
          </select>
        )}
      </FormField>
      {custom && (
        <FormField
          id="cloud-region"
          label={m.regionCode}
          hint={m.regionCodeHint(regions[0]?.id ?? "")}
          error={error}
        >
          {(p) => (
            <input
              {...p}
              name="region-code"
              className="inp mono"
              autoComplete="off"
              spellCheck={false}
              value={value}
              onChange={(e) => onChange(e.target.value)}
            />
          )}
        </FormField>
      )}
    </>
  );
}

/**
 * [Plan #58 UX-16] Việc cần làm bên cloud thành các BƯỚC đánh số: tiêu đề, làm ở đâu (link tới đúng trang của console)
 * và thay gì, rồi khối lệnh. Bước cuối nói quay lại đây điền và lưu.
 */
function Snippets({
  method,
  provider,
  canEdit,
}: {
  method: Method;
  provider: CloudProviderWire;
  canEdit: boolean;
}) {
  const m = useMessages(cloudMessages);
  return (
    <ol className="snips cloud-steps" aria-label={m.editor.snippets}>
      {method.snippets.map((s) => {
        const how = textOf(m.snippetHow, s.id);
        const url = CONSOLE_URL[s.id];
        return (
          <li key={s.id}>
            <h3>{labelOf(m.snippet, s.id)}</h3>
            {(how !== undefined || url !== undefined) && (
              <p className="c3">
                {how}{" "}
                {url !== undefined && (
                  <a href={url} target="_blank" rel="noreferrer">
                    {m.editor.openConsole(PROVIDER_LABEL[provider])}
                    <Icon of={ExternalLink} size={12} />
                  </a>
                )}
              </p>
            )}
            <CodeBlock code={s.content} label={labelOf(m.snippet, s.id)} />
          </li>
        );
      })}
      {canEdit && (
        <li>
          <h3>{m.editor.finalStep}</h3>
          <p className="c3">{m.editor.finalStepHow}</p>
        </li>
      )}
    </ol>
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
