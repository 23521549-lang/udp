import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  BUILD_LANGUAGES,
  BUILD_STRATEGIES,
  BUILD_TEXT_RULES,
  identityLineSchema,
  isSafeBuildPath,
  type BuildLanguage,
  type BuildSettings,
  type IdentityLine,
} from "@udp/shared-types/build";
import type { BuildTodoWire, BuildViewWire } from "@udp/shared-types/wire";
import {
  CircleCheck,
  CircleX,
  KeyRound,
  ShieldCheck,
  TriangleAlert,
} from "lucide-react";
import { useState, type FormEvent } from "react";
import { CodeBlock } from "../../components/CodeBlock";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { Field } from "../../components/Field";
import { Icon } from "../../components/Icon";
import { InfoTip } from "../../components/InfoTip";
import { ErrorState, Loading } from "../../components/States";
import { Switch } from "../../components/Switch";
import { useMessages } from "../../i18n";
import { formatDateTime } from "../../lib/format";
import { qk } from "../../lib/query-keys";
import { useProjectContext } from "../project/ProjectLayout";
import { can } from "../project/roles";
import { codeApi } from "./code-api";
import { packagingMessages, type RebaseHow } from "./packaging.messages";

/**
 * [Plan #61 QĐ-9] Mục "Đóng gói" của trang Mã nguồn: UDP sẽ build image thế nào và vì sao, người dùng còn phải làm gì
 * để pipeline đẩy được (secret, danh tính build, lệnh test), và cài đặt build. Đọc ĐÚNG kế hoạch mà pipeline dùng
 * (`GET /projects/:id/build`) — không có quy tắc nào được viết lại ở đây.
 */
export function PackagingPanel() {
  const { project } = useProjectContext();
  const build = useQuery({
    queryKey: qk.projectBuild(project.id),
    queryFn: () => codeApi.build(project.id),
  });
  if (build.isPending) return <Loading />;
  if (build.isError) return <ErrorState error={build.error} />;
  return <PackagingView view={build.data} />;
}

/** Kết quả mới vào cache; pipeline và Golden Path (mang pipeline) đọc lại */
function useBuildMutation<T>(
  call: (projectId: string, input: T) => Promise<BuildViewWire>,
) {
  const { project } = useProjectContext();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: T) => call(project.id, input),
    onSuccess: (data) => {
      queryClient.setQueryData(qk.projectBuild(project.id), data);
      void queryClient.invalidateQueries({
        queryKey: qk.pipelineTemplate(project.id),
      });
      void queryClient.invalidateQueries({
        queryKey: qk.goldenPath(project.id),
      });
    },
  });
}

const useSaveBuild = () => useBuildMutation(codeApi.saveBuild);

function PackagingView({ view }: { view: BuildViewWire }) {
  const m = useMessages(packagingMessages);
  const { project } = useProjectContext();
  const canEdit = can(project.myRole, "MAINTAINER");
  const languageName = m.languageName[view.language.value];
  const dockerfile =
    view.settings.context === "."
      ? view.settings.dockerfile
      : `${view.settings.context}/${view.settings.dockerfile}`;
  const reason = m.reason[view.prediction.reason](
    view.prediction.reason === "SCAN_DOCKERFILE" ? dockerfile : languageName,
  );
  return (
    <section className="cardc packaging" aria-labelledby="packaging-title">
      <div className="hd">
        <h2 id="packaging-title">{m.title}</h2>
        <InfoTip term="buildpacks" />
      </div>
      <p className="c3 packaging-lead">{m.lead}</p>
      <div className="kpis">
        <div className="kpi">
          <div className="l">{m.builtWith}</div>
          <div>{m.predicted[view.prediction.strategy]}</div>
          <div className="c3">{reason}</div>
        </div>
        <div className="kpi">
          <div className="l">{m.language}</div>
          <div>{languageName}</div>
          <div className="c3">{m.languageSource[view.language.source]}</div>
        </div>
        <div className="kpi">
          <div className="l">{m.pushTo}</div>
          {view.registry === null ? (
            <div>{m.noRegistry}</div>
          ) : (
            <>
              <div className="mono">{view.registry.server}</div>
              <div className="c3">{m.push[view.registry.effectivePush]}</div>
            </>
          )}
        </div>
        <div className="kpi">
          <div className="l">{m.platform}</div>
          <div className="mono">{view.platform}</div>
        </div>
      </div>
      <TestLine view={view} />
      <RebaseLine view={view} />
      <Todo view={view} />
      {view.identity.required && (
        <IdentitySection view={view} canEdit={canEdit} />
      )}
      {view.ci !== null && <SigningSection view={view} canEdit={canEdit} />}
      <SettingsForm view={view} canEdit={canEdit} />
    </section>
  );
}

function TestLine({ view }: { view: BuildViewWire }) {
  const m = useMessages(packagingMessages);
  const test = view.test;
  return (
    <div className="packaging-row">
      <span className="l">{m.test}</span>
      {test.kind === "run" ? (
        <span>
          <code className="mono">{test.command}</code>{" "}
          <span className="c3 mono">{m.testImage(test.image)}</span>
        </span>
      ) : test.kind === "skip" ? (
        <span className="c3">{m.testSkip}</span>
      ) : (
        <span className="stt warn">
          <Icon of={CircleX} />
          {m.testMissing(m.languageName[test.language])}
        </span>
      )}
    </div>
  );
}

const pad = (n: number): string => String(n).padStart(2, "0");

/** [Plan #61 QĐ-13] Vá image nền theo lịch: giờ chạy (UTC) và cách đặt lịch ở CI đang bật */
function RebaseLine({ view }: { view: BuildViewWire }) {
  const m = useMessages(packagingMessages);
  if (view.ci === null) return null;
  const rebase = view.rebase;
  const time =
    rebase === null ? "" : `${pad(rebase.hour)}:${pad(rebase.minute)}`;
  const how: RebaseHow | undefined =
    view.ci in m.rebaseHow
      ? m.rebaseHow[view.ci as keyof PackagingText["rebaseHow"]]
      : undefined;
  return (
    <div className="packaging-row">
      <span className="l">
        {m.rebase}
        <InfoTip term="rebase" />
      </span>
      {rebase === null ? (
        <span className="c3">{m.rebaseOff}</span>
      ) : (
        <span>
          {m.rebaseWhen(time)}{" "}
          <span className="c3">{how?.(rebase.cron, time)}</span>
        </span>
      )}
    </div>
  );
}

type PackagingText = (typeof packagingMessages)["vi"];

function todoText(m: PackagingText, t: BuildTodoWire): string {
  switch (t.code) {
    case "CI_SECRETS": {
      const names = t.names.join(", ");
      return (m.secrets[t.ci] ?? m.secretsFallback)(names);
    }
    case "BUILD_IDENTITY":
      return m.todo.BUILD_IDENTITY(m.cloud[t.cloud]);
    case "SIGNING_KEY":
      return m.todo.SIGNING_KEY(m.cloud[t.cloud]);
    case "TEST_COMMAND":
      return m.todo.TEST_COMMAND(m.languageName[t.language]);
    case "NEEDS_DOCKERFILE":
      return m.todo.NEEDS_DOCKERFILE(m.languageName[t.language]);
    default:
      return m.todo[t.code];
  }
}

function Todo({ view }: { view: BuildViewWire }) {
  const m = useMessages(packagingMessages);
  if (view.todo.length === 0) {
    return (
      <div className="alert ok" role="status">
        <Icon of={CircleCheck} />
        <div>{m.allSet}</div>
      </div>
    );
  }
  return (
    <div className="alert amber" role="status">
      <Icon of={TriangleAlert} />
      <div>
        <b>{m.todoTitle}</b>
        <ul className="packaging-todo">
          {view.todo.map((t) => (
            <li key={t.code}>{todoText(m, t)}</li>
          ))}
        </ul>
      </div>
    </div>
  );
}

const IDENTITY_PREFIX = "UDP_BUILD_IDENTITY=";

/**
 * Dòng script in ra (có hay không tiền tố, có thể kèm các dòng khác) ⇒ danh tính và, khi script tạo khoá ký, `signing`
 * (URI KMS và khoá CÔNG KHAI) — hay `null`
 */
export function parseIdentityLine(text: string): IdentityLine | null {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l !== "");
  const line = lines.find((l) => l.startsWith(IDENTITY_PREFIX)) ?? lines[0];
  if (line === undefined) return null;
  const json = line.startsWith(IDENTITY_PREFIX)
    ? line.slice(IDENTITY_PREFIX.length)
    : line;
  try {
    const parsed = identityLineSchema.safeParse(JSON.parse(json));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function IdentitySection({
  view,
  canEdit,
}: {
  view: BuildViewWire;
  canEdit: boolean;
}) {
  const m = useMessages(packagingMessages);
  const save = useSaveBuild();
  const [pasted, setPasted] = useState("");
  const [error, setError] = useState<string | undefined>();
  const cloud = view.identity.cloud;
  const cloudName = cloud === null ? "" : m.cloud[cloud];

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const line = parseIdentityLine(pasted);
    if (line === null) {
      setError(m.pasteInvalid);
      return;
    }
    if (line.cloud !== cloud) {
      setError(m.pasteWrongCloud(cloudName));
      return;
    }
    setError(undefined);
    const { signing, ...identity } = line;
    save.mutate(
      {
        ...view.settings,
        identity,
        signing: { ...view.settings.signing, keys: withKey(view, signing) },
      },
      { onSuccess: () => setPasted("") },
    );
  };

  return (
    <div className="packaging-identity">
      <h3>
        <Icon of={KeyRound} />
        {m.identityTitle}
        <InfoTip term="buildIdentity" />
      </h3>
      <p className="c3">{m.identityWhy}</p>
      <span className={view.identity.configured ? "stt" : "stt warn"}>
        <Icon of={view.identity.configured ? CircleCheck : CircleX} />
        {view.identity.configured ? m.identityOk : m.identityMissing}
      </span>
      {view.identityScript !== null && (
        <CodeBlock
          code={view.identityScript.text}
          label={m.scriptLabel(m.cloud[view.identityScript.cloud])}
          copyLabel={m.scriptCopy}
        />
      )}
      {canEdit && view.identityScript !== null && (
        <form className="packaging-form" onSubmit={submit}>
          <Field label={m.paste} hint={m.pasteHint} error={error}>
            {(p) => (
              <textarea
                className="inp mono"
                rows={2}
                spellCheck={false}
                {...p}
                value={pasted}
                onChange={(e) => setPasted(e.target.value)}
              />
            )}
          </Field>
          <button type="submit" className="btn pri" disabled={save.isPending}>
            {save.isPending ? m.saving : m.saveIdentity}
          </button>
          {save.isError && <ErrorState error={save.error} />}
        </form>
      )}
    </div>
  );
}

type SigningKeys = BuildSettings["signing"]["keys"];

/** Khoá vừa dán lên ĐẦU danh sách (khoá đầu là khoá ký), bỏ bản trùng, giữ trong giới hạn 5 khoá */
function withKey(
  view: BuildViewWire,
  key: IdentityLine["signing"],
): SigningKeys {
  const keys = view.settings.signing.keys;
  if (key === undefined) return keys;
  return [
    { publicKey: key.publicKey, kms: key.key },
    ...keys.filter((k) => k.publicKey !== key.publicKey),
  ].slice(0, 5);
}

/**
 * [Plan #61 QĐ-14, QĐ-16] Ký image: khoá (dấu vân tay, URI KMS, ngày thêm), chữ ký tương thích, chế độ bắt buộc. Cổng
 * deploy tự bật bắt buộc ở chữ ký hợp lệ đầu tiên; tắt hay bật tay là thao tác riêng, có xác nhận và nhật ký.
 */
function SigningSection({
  view,
  canEdit,
}: {
  view: BuildViewWire;
  canEdit: boolean;
}) {
  const m = useMessages(packagingMessages);
  const save = useSaveBuild();
  const enforce = useBuildMutation(codeApi.setSigningEnforce);
  const [removing, setRemoving] = useState<string | null>(null);
  const [confirmEnforce, setConfirmEnforce] = useState<boolean | null>(null);
  const signing = view.settings.signing;
  const keys = signing.keys;

  const removeKey = (id: string) =>
    save.mutate(
      {
        ...view.settings,
        signing: { ...signing, keys: keys.filter((k) => k.id !== id) },
      },
      { onSuccess: () => setRemoving(null) },
    );

  return (
    <div className="packaging-identity">
      <h3>
        <Icon of={ShieldCheck} />
        {m.signingTitle}
        <InfoTip term="imageSigning" />
      </h3>
      <p className="c3">{m.signingWhy}</p>
      {view.signing.available && <p className="c3">{m.signingCost}</p>}
      {view.signing.reason !== null && (
        <p className="stt warn">
          <Icon of={CircleX} />
          {m.signingBlocked[view.signing.reason]}
        </p>
      )}
      {keys.length === 0 ? (
        view.signing.available && <p className="c3">{m.noKeys}</p>
      ) : (
        <>
          <div
            className="table-wrap"
            tabIndex={0}
            role="region"
            aria-label={m.keys}
          >
            <table className="dtable">
              <thead>
                <tr>
                  <th scope="col">{m.keyId}</th>
                  <th scope="col">{m.keyKms}</th>
                  <th scope="col">{m.keyAdded}</th>
                  <th scope="col">
                    <span className="visually-hidden">{m.keyActions}</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {keys.map((k, i) => (
                  <tr key={k.id ?? k.publicKey}>
                    <td>
                      <span className="mono">{k.id}</span>{" "}
                      <span className="c3">
                        {i === 0 ? m.keySigning : m.keyAccepted}
                      </span>
                    </td>
                    <td className="mono">{k.kms}</td>
                    <td>
                      {k.addedAt === undefined ? "" : formatDateTime(k.addedAt)}
                    </td>
                    <td>
                      {canEdit && k.id !== undefined && (
                        <button
                          type="button"
                          className="btn danger"
                          onClick={() => setRemoving(k.id ?? null)}
                        >
                          {m.removeKey(k.id)}
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="packaging-row">
            <span className="l">{m.compat}</span>
            <span>
              <Switch
                checked={signing.compat}
                label={m.compat}
                disabled={!canEdit || save.isPending}
                onChange={(compat) =>
                  save.mutate({
                    ...view.settings,
                    signing: { ...signing, compat },
                  })
                }
              />{" "}
              <span className="c3">{m.compatHint}</span>
            </span>
          </div>
          <div className="packaging-row">
            <span className={signing.enforce ? "stt" : "stt warn"}>
              <Icon of={signing.enforce ? CircleCheck : TriangleAlert} />
              {signing.enforce ? m.enforced : m.waiting}
            </span>
            {/* Bật bắt buộc khi pipeline không ký được thì mọi lần deploy đều bị từ chối */}
            {canEdit && (signing.enforce || view.signing.available) && (
              <button
                type="button"
                className="btn"
                onClick={() => setConfirmEnforce(!signing.enforce)}
              >
                {signing.enforce ? m.enforceOff : m.enforceOn}
              </button>
            )}
          </div>
        </>
      )}
      {save.isError && <ErrorState error={save.error} />}
      {removing !== null && (
        <ConfirmDialog
          title={m.removeKeyTitle}
          description={
            keys.length === 1 ? m.removeLastKeyBody : m.removeKeyBody(removing)
          }
          confirmLabel={m.removeKeyConfirm}
          danger
          busy={save.isPending}
          onConfirm={() => removeKey(removing)}
          onClose={() => setRemoving(null)}
        />
      )}
      {confirmEnforce !== null && (
        <ConfirmDialog
          title={confirmEnforce ? m.enforceOnTitle : m.enforceOffTitle}
          description={confirmEnforce ? m.enforceOnBody : m.enforceOffBody}
          confirmLabel={confirmEnforce ? m.enforceOn : m.enforceOff}
          danger={!confirmEnforce}
          busy={enforce.isPending}
          error={enforce.isError ? enforce.error.message : undefined}
          onConfirm={() =>
            enforce.mutate(confirmEnforce, {
              onSuccess: () => setConfirmEnforce(null),
            })
          }
          onClose={() => setConfirmEnforce(null)}
        />
      )}
    </div>
  );
}

type TestMode = BuildSettings["test"]["mode"];

function SettingsForm({
  view,
  canEdit,
}: {
  view: BuildViewWire;
  canEdit: boolean;
}) {
  const m = useMessages(packagingMessages);
  const save = useSaveBuild();
  const initial = view.settings;
  const [strategy, setStrategy] = useState(initial.strategy);
  const [context, setContext] = useState(initial.context);
  const [dockerfile, setDockerfile] = useState(initial.dockerfile);
  const [language, setLanguage] = useState<BuildLanguage | "">(
    initial.language ?? "",
  );
  const [mode, setMode] = useState<TestMode>(initial.test.mode);
  const [command, setCommand] = useState(
    initial.test.mode === "custom" ? initial.test.command : "",
  );
  const [image, setImage] = useState(
    initial.test.mode === "custom" ? initial.test.image : "",
  );
  const [touched, setTouched] = useState(false);

  const errors = {
    context: isSafeBuildPath(context) ? undefined : m.pathInvalid,
    dockerfile:
      isSafeBuildPath(dockerfile) && dockerfile !== "."
        ? undefined
        : m.pathInvalid,
    command:
      mode !== "custom" || BUILD_TEXT_RULES.COMMAND.test(command)
        ? undefined
        : m.commandInvalid,
    image:
      mode !== "custom" || BUILD_TEXT_RULES.IMAGE.test(image)
        ? undefined
        : m.imageInvalid,
  };
  const shown = (e: string | undefined) => (touched ? e : undefined);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setTouched(true);
    if (Object.values(errors).some((v) => v !== undefined)) return;
    save.mutate({
      ...initial,
      strategy,
      context,
      dockerfile,
      language: language === "" ? null : language,
      test: mode === "custom" ? { mode, command, image } : { mode },
    });
  };

  return (
    <form className="packaging-form" onSubmit={submit}>
      <h3>{m.settingsTitle}</h3>
      {!canEdit && <p className="c3">{m.readOnly}</p>}
      <fieldset disabled={!canEdit || save.isPending}>
        <Field label={m.strategy}>
          {(p) => (
            <select
              className="inp"
              {...p}
              value={strategy}
              onChange={(e) =>
                setStrategy(e.target.value as BuildSettings["strategy"])
              }
            >
              {BUILD_STRATEGIES.map((s) => (
                <option key={s} value={s}>
                  {m.strategyName[s]}
                </option>
              ))}
            </select>
          )}
        </Field>
        <div className="packaging-grid">
          <Field
            label={m.context}
            hint={m.contextHint}
            error={shown(errors.context)}
          >
            {(p) => (
              <input
                className="inp mono"
                spellCheck={false}
                {...p}
                value={context}
                onChange={(e) => setContext(e.target.value)}
              />
            )}
          </Field>
          <Field
            label={m.dockerfile}
            hint={m.dockerfileHint}
            error={shown(errors.dockerfile)}
          >
            {(p) => (
              <input
                className="inp mono"
                spellCheck={false}
                {...p}
                value={dockerfile}
                onChange={(e) => setDockerfile(e.target.value)}
              />
            )}
          </Field>
        </div>
        <Field label={m.languageField}>
          {(p) => (
            <select
              className="inp"
              {...p}
              value={language}
              onChange={(e) =>
                setLanguage(e.target.value as BuildLanguage | "")
              }
            >
              <option value="">
                {m.languageAuto(m.languageName[view.language.value])}
              </option>
              {BUILD_LANGUAGES.map((l) => (
                <option key={l} value={l}>
                  {m.languageName[l]}
                </option>
              ))}
            </select>
          )}
        </Field>
        <Field label={m.testMode}>
          {(p) => (
            <select
              className="inp"
              {...p}
              value={mode}
              onChange={(e) => setMode(e.target.value as TestMode)}
            >
              {(["default", "custom", "none"] as const).map((t) => (
                <option key={t} value={t}>
                  {m.testModeName[t]}
                </option>
              ))}
            </select>
          )}
        </Field>
        {mode === "custom" && (
          <div className="packaging-grid">
            <Field
              label={m.command}
              hint={m.commandHint}
              error={shown(errors.command)}
            >
              {(p) => (
                <input
                  className="inp mono"
                  spellCheck={false}
                  {...p}
                  value={command}
                  onChange={(e) => setCommand(e.target.value)}
                />
              )}
            </Field>
            <Field
              label={m.image}
              hint={m.imageHint}
              error={shown(errors.image)}
            >
              {(p) => (
                <input
                  className="inp mono"
                  spellCheck={false}
                  {...p}
                  value={image}
                  onChange={(e) => setImage(e.target.value)}
                />
              )}
            </Field>
          </div>
        )}
        {canEdit && (
          <button type="submit" className="btn pri">
            {save.isPending ? m.saving : m.save}
          </button>
        )}
      </fieldset>
      {save.isSuccess && (
        <p className="c3" role="status">
          {m.saved}
        </p>
      )}
      {save.isError && <ErrorState error={save.error} />}
    </form>
  );
}
