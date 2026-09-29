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
import { formatDateTime } from "../../lib/format";
import { qk } from "../../lib/query-keys";
import { ProjectBar } from "../project/ProjectBar";
import { useProjectContext } from "../project/ProjectLayout";
import { can } from "../project/roles";
import { codeApi } from "./code-api";
import { download, zip } from "./zip";
import { PageHead } from "../../components/PageHead";

/**
 * Mã nguồn của project (§11, Plan #48): project Create New ⇒ cây Golden Path (§11.1) để tải về;
 * project Import Existing ⇒ kết quả quét repo có sẵn (§11.2). Portal chỉ ĐỀ XUẤT — không nút nào ghi
 * vào repo của developer.
 */
export function CodePage() {
  const { project } = useProjectContext();
  return (
    <>
      <ProjectBar title="Mã nguồn" />
      <div className="scroll">
        <PageHead
          title="Mã nguồn"
          lead={
            project.creationMode === "CREATE_NEW"
              ? "Golden Path: dự án mẫu đã tích hợp sẵn provider, middleware đo và pipeline của UDP."
              : "Quét repo có sẵn để biết còn thiếu gì trước khi dùng rollout mức flag."
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
  const { project } = useProjectContext();
  if (!can(project.myRole, "DEVELOPER")) {
    return (
      <Empty title="Cần quyền Lập trình viên">
        Golden Path là mã để đưa vào repo, nên chỉ Lập trình viên trở lên xem
        được.
      </Empty>
    );
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
          <span className="c3">{files.length} tệp</span>
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
              Tải .zip
            </button>
          </div>
        </div>
        <div className="lst files" aria-label="Tệp của Golden Path">
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
          label={`Nội dung ${current.path}`}
          copyLabel={`Sao chép ${current.path}`}
        />
      )}
    </>
  );
}

// ------------------------------------------------------------- Import Existing

const STATUS_ICON = { ok: CircleCheck, missing: CircleX, unknown: CircleHelp };
const STATUS_LABEL = {
  ok: "Đã có",
  missing: "Còn thiếu",
  unknown: "Chưa xác định",
};

const FINDING_TITLE: Record<RepoScanWire["findings"][number]["id"], string> = {
  runtime: "Ngôn ngữ",
  dockerfile: "Dockerfile",
  "metrics-endpoint": "Endpoint /metrics",
  openfeature: "OpenFeature SDK",
  "udp-provider": "Provider của UDP",
  "udp-middleware": "Middleware đo của UDP",
  "service-version": "service.version trong manifest",
  pipeline: "Pipeline báo deploy về UDP",
};

function RepoScanView() {
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
              aria-label="Token đọc repo (tuỳ chọn, cho repo riêng tư)"
              placeholder="Token cho repo riêng tư (tuỳ chọn)…"
              value={token}
              onChange={(e) => setToken(e.target.value)}
            />
            <button type="submit" className="btn pri" disabled={scan.isPending}>
              <Icon of={ScanSearch} />
              {scan.isPending ? "Đang quét…" : "Quét repo"}
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
        <Empty title="Chưa quét repo lần nào">
          {canScan
            ? "Bấm Quét repo: UDP đọc repo qua API công khai của GitHub/GitLab và chỉ đưa ra đề xuất."
            : "Nhờ Lập trình viên của project quét repo."}
        </Empty>
      ) : (
        <ScanResult scan={last.data.scan} />
      )}
    </>
  );
}

function ScanResult({ scan }: { scan: RepoScanWire }) {
  const [open, setOpen] = useState<string | null>(null);
  return (
    <>
      <div className="kpis">
        <ReadinessKpi scan={scan} />
        <div className="kpi">
          <div className="l">Nhận diện</div>
          <div>
            {scan.runtime ?? "Không rõ ngôn ngữ"}
            {scan.framework === null ? "" : ` · ${scan.framework}`}
          </div>
          <div className="c3">
            CI/CD: {scan.cicdTool ?? "không thấy"} · quét lúc{" "}
            {formatDateTime(scan.scannedAt)}
          </div>
        </div>
      </div>
      {scan.truncated && (
        <div className="alert amber" role="status">
          <Icon of={TriangleAlert} />
          <div>
            Repo lớn hơn trần đọc của một lượt quét: mục "Chưa xác định" có thể
            đã có mà UDP không đọc tới.
          </div>
        </div>
      )}
      <div className="lst" aria-label="Kết quả quét">
        {scan.findings.map((f) => (
          <div key={f.id} className="it finding">
            <div className="head">
              <span className={f.status === "ok" ? "stt" : "stt warn"}>
                <Icon of={STATUS_ICON[f.status]} />
                {STATUS_LABEL[f.status]}
              </span>
              <b style={{ fontWeight: 500 }}>{FINDING_TITLE[f.id]}</b>
              <span className="c3">{f.detail}</span>
            </div>
            {f.evidence.length > 0 && (
              <div className="c3 mono">{f.evidence.join(", ")}</div>
            )}
            {f.suggestion !== undefined && (
              <div className="c3">
                Đề xuất: {f.suggestion.text}
                {f.suggestion.file !== undefined && (
                  <>
                    {" "}
                    <button
                      type="button"
                      className="btn"
                      aria-expanded={open === f.id}
                      onClick={() => setOpen(open === f.id ? null : f.id)}
                    >
                      {open === f.id ? "Ẩn" : "Xem"} {f.suggestion.file.path}
                    </button>
                  </>
                )}
              </div>
            )}
            {open === f.id && f.suggestion?.file !== undefined && (
              <CodeBlock
                code={f.suggestion.file.content}
                label={`Mẫu ${f.suggestion.file.path}`}
                copyLabel={`Sao chép ${f.suggestion.file.path}`}
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
  const missing = scan.findings.filter(
    (f) =>
      (f.id === "udp-provider" || f.id === "udp-middleware") &&
      f.status !== "ok",
  );
  return (
    <div className="kpi" aria-label="Sẵn sàng cho flag-level rollout">
      <div className="l">Sẵn sàng cho flag-level rollout</div>
      <span className={scan.flagLevelReady ? "stt" : "stt warn"}>
        <Icon of={scan.flagLevelReady ? CircleCheck : CircleX} />
        {scan.flagLevelReady ? "Sẵn sàng" : "Chưa sẵn sàng"}
      </span>
      {missing.map((f) => (
        <div key={f.id} className="c3">
          Thiếu: {FINDING_TITLE[f.id]}
        </div>
      ))}
    </div>
  );
}
