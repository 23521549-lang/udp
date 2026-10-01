import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  BUILD_LANGUAGES,
  BUILD_STRATEGIES,
  BUILD_TEXT_RULES,
  buildIdentitySchema,
  isSafeBuildPath,
  type BuildIdentityInput,
  type BuildLanguage,
  type BuildSettings,
} from "@udp/shared-types/build";
import type { BuildTodoWire, BuildViewWire } from "@udp/shared-types/wire";
import { CircleCheck, CircleX, KeyRound, TriangleAlert } from "lucide-react";
import { useState, type FormEvent } from "react";
import { CodeBlock } from "../../components/CodeBlock";
import { Field } from "../../components/Field";
import { Icon } from "../../components/Icon";
import { InfoTip } from "../../components/InfoTip";
import { ErrorState, Loading } from "../../components/States";
import { useMessages } from "../../i18n";
import { qk } from "../../lib/query-keys";
import { useProjectContext } from "../project/ProjectLayout";
import { can } from "../project/roles";
import { codeApi } from "./code-api";
import { packagingMessages } from "./packaging.messages";

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

/** Lưu cài đặt: kết quả mới vào cache; pipeline và Golden Path (mang pipeline) đọc lại */
function useSaveBuild() {
  const { project } = useProjectContext();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (settings: BuildSettings) =>
      codeApi.saveBuild(project.id, settings),
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
      <Todo view={view} />
      {view.identity.required && (
        <IdentitySection view={view} canEdit={canEdit} />
      )}
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

type PackagingText = (typeof packagingMessages)["vi"];

function todoText(m: PackagingText, t: BuildTodoWire): string {
  switch (t.code) {
    case "CI_SECRETS": {
      const names = t.names.join(", ");
      return (m.secrets[t.ci] ?? m.secretsFallback)(names);
    }
    case "BUILD_IDENTITY":
      return m.todo.BUILD_IDENTITY(m.cloud[t.cloud]);
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

/** Dòng script in ra (có hay không tiền tố, có thể kèm các dòng khác) ⇒ danh tính, hay `null` */
export function parseIdentityLine(text: string): BuildIdentityInput | null {
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
    const parsed = buildIdentitySchema.safeParse(JSON.parse(json));
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
    const identity = parseIdentityLine(pasted);
    if (identity === null) {
      setError(m.pasteInvalid);
      return;
    }
    if (identity.cloud !== cloud) {
      setError(m.pasteWrongCloud(cloudName));
      return;
    }
    setError(undefined);
    save.mutate(
      { ...view.settings, identity },
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
