import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  GoldenPathResponseWire,
  RepoScanWire,
} from "@udp/shared-types/wire";
import {
  CircleCheck,
  CircleHelp,
  CircleX,
  Download,
  ScanSearch,
  TriangleAlert,
} from "lucide-react";
import { useState } from "react";
import { CodeBlock } from "../../components/CodeBlock";
import { Icon } from "../../components/Icon";
import { Empty, ErrorState, Loading } from "../../components/States";
import { useMessages } from "../../i18n";
import { formatDateTime } from "../../lib/format";
import { qk } from "../../lib/query-keys";
import { ProjectBar } from "../project/ProjectBar";
import { useProjectContext } from "../project/ProjectLayout";
import { can } from "../project/roles";
import { codeApi } from "./code-api";
import { codeMessages } from "./code.messages";
import { download, zip } from "./zip";
import { PageHead } from "../../components/PageHead";

/**
 * Mã nguồn của project (§11, Plan #48): project Create New ⇒ cây Golden Path (§11.1) để tải về;
 * project Import Existing ⇒ kết quả quét repo có sẵn (§11.2). Portal chỉ ĐỀ XUẤT — không nút nào ghi
 * vào repo của developer.
 */
export function CodePage() {
  const m = useMessages(codeMessages);
  const { project } = useProjectContext();
  return (
    <>
      <ProjectBar title={m.title} />
      <div className="scroll">
        <PageHead
          title={m.title}
          lead={
            project.creationMode === "CREATE_NEW" ? m.leadCreate : m.leadImport
          }
        />
        <div className="page">
          {project.creationMode === "CREATE_NEW" ? (
            <GoldenPathView />
          ) : (
            <RepoScanView />
          )}
        </div>
      </div>
    </>
  );
}

// ------------------------------------------------------------- Golden Path

function GoldenPathView() {
  const m = useMessages(codeMessages);
  const { project } = useProjectContext();
  if (!can(project.myRole, "DEVELOPER")) {
    return <Empty title={m.needDeveloper}>{m.needDeveloperHint}</Empty>;
  }
  return <GoldenPathFiles />;
}

/** Cây tệp kèm pipeline (nếu sinh được) — pipeline là một tệp như mọi tệp khác của repo */
function filesOf(data: GoldenPathResponseWire) {
  return data.pipeline === null
    ? data.files
    : [
        ...data.files,
        { path: data.pipeline.path, content: data.pipeline.content },
      ];
}

function GoldenPathFiles() {
  const m = useMessages(codeMessages);
  const { project } = useProjectContext();
  const tree = useQuery({
    queryKey: qk.goldenPath(project.id),
    queryFn: () => codeApi.goldenPath(project.id),
  });
  const [selected, setSelected] = useState<string | null>(null);
  if (tree.isPending) return <Loading />;
  if (tree.isError) return <ErrorState error={tree.error} />;

  const files = filesOf(tree.data);
  const current = files.find((f) => f.path === selected) ?? files[0];
  return (
    <>
      {tree.data.notes.map((note) => (
        <div key={note} className="alert amber" role="status">
          <Icon of={TriangleAlert} />
          <div>{note}</div>
        </div>
      ))}
      <div className="cardc">
        <div className="hd">
          <h2>
            {tree.data.runtime === "nodejs" ? "Node.js" : "Python"} ·{" "}
            <span className="mono">{tree.data.slug}</span>
          </h2>
          <span className="c3">{m.fileCount(files.length)}</span>
          <div className="r">
            <button
              type="button"
              className="btn pri"
              onClick={() => {
                const bytes = zip(files);
                download(
                  `${tree.data.slug}.zip`,
                  new Blob([bytes], { type: "application/zip" }),
                );
              }}
            >
              <Icon of={Download} />
              {m.downloadZip}
            </button>
          </div>
        </div>
        <div className="lst files" aria-label={m.files}>
          {files.map((f) => (
            <button
              key={f.path}
              type="button"
              className="it mono"
              aria-pressed={f.path === current?.path}
              onClick={() => setSelected(f.path)}
            >
              {f.path}
            </button>
          ))}
        </div>
      </div>
      {current !== undefined && (
        <CodeBlock
          code={current.content}
          label={m.contentOf(current.path)}
          copyLabel={m.copyOf(current.path)}
        />
      )}
    </>
  );
}

// ------------------------------------------------------------- Import Existing

const STATUS_ICON = { ok: CircleCheck, missing: CircleX, unknown: CircleHelp };

function RepoScanView() {
  const m = useMessages(codeMessages);
  const { project } = useProjectContext();
  const queryClient = useQueryClient();
  const [token, setToken] = useState("");
  const last = useQuery({
    queryKey: qk.repoScan(project.id),
    queryFn: () => codeApi.lastScan(project.id),
  });
  const scan = useMutation({
    mutationFn: () =>
      codeApi.scan(project.id, token.trim() === "" ? undefined : token.trim()),
    onSuccess: (data) => {
      // Token chỉ sống cho lượt quét này — xoá khỏi ô ngay khi xong
      setToken("");
      queryClient.setQueryData(qk.repoScan(project.id), data);
    },
  });
  const canScan = can(project.myRole, "DEVELOPER");

  return (
    <>
      <div className="cardc">
        <div className="hd">
          <h2 className="mono">{project.repoUrl}</h2>
        </div>
        {canScan && (
          <form
            className="scanform"
            onSubmit={(e) => {
              e.preventDefault();
              scan.mutate();
            }}
          >
            <input
              type="password"
              className="inp"
              autoComplete="off"
              aria-label={m.token}
              placeholder={m.tokenPlaceholder}
              value={token}
              onChange={(e) => setToken(e.target.value)}
            />
            <button type="submit" className="btn pri" disabled={scan.isPending}>
              <Icon of={ScanSearch} />
              {scan.isPending ? m.scanning : m.scan}
            </button>
          </form>
        )}
      </div>
      {scan.isError && <ErrorState error={scan.error} />}
      {last.isPending ? (
        <Loading />
      ) : last.isError ? (
        <ErrorState error={last.error} />
      ) : last.data.scan === null ? (
        <Empty title={m.neverScanned}>
          {canScan ? m.neverScannedHint : m.askDeveloper}
        </Empty>
      ) : (
        <ScanResult scan={last.data.scan} />
      )}
    </>
  );
}

function ScanResult({ scan }: { scan: RepoScanWire }) {
  const m = useMessages(codeMessages);
  const [open, setOpen] = useState<string | null>(null);
  return (
    <>
      <div className="kpis">
        <ReadinessKpi scan={scan} />
        <div className="kpi">
          <div className="l">{m.detected}</div>
          <div>
            {scan.runtime ?? m.unknownRuntime}
            {scan.framework === null ? "" : ` · ${scan.framework}`}
          </div>
          <div className="c3">
            {m.scanMeta(scan.cicdTool, formatDateTime(scan.scannedAt))}
          </div>
        </div>
      </div>
      {scan.truncated && (
        <div className="alert amber" role="status">
          <Icon of={TriangleAlert} />
          <div>{m.truncated}</div>
        </div>
      )}
      <div className="lst" aria-label={m.results}>
        {scan.findings.map((f) => (
          <div key={f.id} className="it finding">
            <div className="head">
              <span className={f.status === "ok" ? "stt" : "stt warn"}>
                <Icon of={STATUS_ICON[f.status]} />
                {m.status[f.status]}
              </span>
              <b style={{ fontWeight: 500 }}>{m.finding[f.id]}</b>
              <span className="c3">{f.detail}</span>
            </div>
            {f.evidence.length > 0 && (
              <div className="c3 mono">{f.evidence.join(", ")}</div>
            )}
            {f.suggestion !== undefined && (
              <div className="c3">
                {m.suggestion(f.suggestion.text)}
                {f.suggestion.file !== undefined && (
                  <>
                    {" "}
                    <button
                      type="button"
                      className="btn"
                      aria-expanded={open === f.id}
                      onClick={() => setOpen(open === f.id ? null : f.id)}
                    >
                      {m.toggleFile(open === f.id, f.suggestion.file.path)}
                    </button>
                  </>
                )}
              </div>
            )}
            {open === f.id && f.suggestion?.file !== undefined && (
              <CodeBlock
                code={f.suggestion.file.content}
                label={m.templateOf(f.suggestion.file.path)}
                copyLabel={m.copyOf(f.suggestion.file.path)}
              />
            )}
          </div>
        ))}
      </div>
    </>
  );
}

/** Hai điều kiện C1 phát hiện được từ mã (§6.6): provider UDP và middleware đo */
export function ReadinessKpi({ scan }: { scan: RepoScanWire }) {
  const m = useMessages(codeMessages);
  const missing = scan.findings.filter(
    (f) =>
      (f.id === "udp-provider" || f.id === "udp-middleware") &&
      f.status !== "ok",
  );
  return (
    <div className="kpi" aria-label={m.readiness}>
      <div className="l">{m.readiness}</div>
      <span className={scan.flagLevelReady ? "stt" : "stt warn"}>
        <Icon of={scan.flagLevelReady ? CircleCheck : CircleX} />
        {scan.flagLevelReady ? m.ready : m.notReady}
      </span>
      {missing.map((f) => (
        <div key={f.id} className="c3">
          {m.missing(m.finding[f.id])}
        </div>
      ))}
    </div>
  );
}
