import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import type {
  ArchitectureToolWire,
  ArchitectureWire,
} from "@udp/shared-types/wire";
import { CircleAlert, X } from "lucide-react";
import { useEffect, useRef } from "react";
import { Icon } from "../../components/Icon";
import { PageHead } from "../../components/PageHead";
import { Empty, ErrorState, Loading } from "../../components/States";
import { StatusLabel } from "../../components/StatusLabel";
import { formatDateTime } from "../../lib/format";
import { qk } from "../../lib/query-keys";
import { DRIFT_LABEL } from "../domain/domain-labels";
import { ProjectBar } from "../project/ProjectBar";
import { useProjectContext } from "../project/ProjectLayout";
import { ArchitectureDiagram } from "./ArchitectureDiagram";
import { architectureApi } from "./architecture-api";
import { healthSummary, relationsOf, toolHealth } from "./architecture-model";

/**
 * Kiến trúc (Plan #53 QĐ-7): hệ thống UDP đã dựng cho project — cloud, mạng, cluster, environment,
 * workload và công cụ — cùng cạnh phụ thuộc tính bởi CHÍNH resolver đã chặn cấu hình sai (QĐ-3).
 * Công cụ đang chọn nằm trên URL (`?tool=`): gửi link là gửi đúng chỗ đang xem.
 */
export function ArchitecturePage() {
  const { project } = useProjectContext();
  const search = useSearch({ from: "/app/projects/$projectId/architecture" });
  const navigate = useNavigate({
    from: "/app/projects/$projectId/architecture",
  });
  const arch = useQuery({
    queryKey: qk.architecture(project.id),
    queryFn: () => architectureApi.get(project.id),
  });

  const select = (tool: string | undefined): void => {
    void navigate({
      search: (prev) => {
        const { tool: _drop, ...rest } = prev;
        return tool === undefined ? rest : { ...rest, tool };
      },
      replace: true,
    });
  };

  const a = arch.data?.architecture;
  const selected =
    a === undefined || search.tool === undefined
      ? undefined
      : a.tools.find((t) => t.key === search.tool);
  const workloads =
    a?.environments.reduce((n, e) => n + e.workloads.length, 0) ?? 0;

  return (
    <>
      <ProjectBar title="Kiến trúc" envScoped={false} />
      <div className="body">
        <div className="scroll">
          <PageHead
            title="Kiến trúc"
            lead="Hạ tầng và công cụ UDP đã dựng cho project, lồng theo cách chúng chứa nhau. Mũi tên chỉ từ công cụ cần tới công cụ cung cấp."
            minis={
              a === undefined
                ? undefined
                : [
                    { value: a.tools.length, label: "công cụ" },
                    { value: a.environments.length, label: "environment" },
                    { value: workloads, label: "workload" },
                  ]
            }
          />
          <div className="page">
            {arch.isPending ? (
              <Loading />
            ) : arch.isError ? (
              <ErrorState
                error={arch.error}
                onRetry={() => void arch.refetch()}
              />
            ) : (
              <ArchitectureBody
                arch={arch.data.architecture}
                projectId={project.id}
                selected={search.tool}
                onSelect={select}
              />
            )}
          </div>
        </div>
        {a !== undefined && selected !== undefined && (
          <ToolPanel
            arch={a}
            tool={selected}
            projectId={project.id}
            onSelect={select}
          />
        )}
      </div>
    </>
  );
}

function ArchitectureBody({
  arch,
  projectId,
  selected,
  onSelect,
}: {
  arch: ArchitectureWire;
  projectId: string;
  selected: string | undefined;
  onSelect: (key: string | undefined) => void;
}) {
  if (arch.cloud === null && arch.tools.length === 0) {
    return (
      <Empty title="Chưa có gì để vẽ">
        Project chưa kết nối cloud và chưa bật domain nào. Sơ đồ hiện ra sau khi
        hạ tầng được dựng.
      </Empty>
    );
  }
  const health = healthSummary(arch.tools);
  const byKey = new Map(arch.tools.map((t) => [t.key, t]));
  const nameOf = (key: string): string => byKey.get(key)?.displayName ?? key;
  return (
    <>
      {!arch.valid && (
        <div className="alert amber" role="status">
          <Icon of={CircleAlert} />
          <div>
            Tổ hợp domain đang bật chưa qua kiểm tra, nên chưa có thứ tự deploy
            và chưa có cạnh.{" "}
            <Link to="/app/projects/$projectId/domains" params={{ projectId }}>
              Xem lỗi ở trang Domain
            </Link>
          </div>
        </div>
      )}
      <p className="c3 arch-sum">
        {arch.tools.length} công cụ: {health.ok} ổn định
        {health.running > 0 && `, ${String(health.running)} đang chạy việc`}
        {health.warn > 0 && `, ${String(health.warn)} cần xem`}
        {health.error > 0 && `, ${String(health.error)} lỗi`}
        {health.unknown > 0 && `, ${String(health.unknown)} chưa triển khai`}.
        Cập nhật {formatDateTime(arch.generatedAt)}.
      </p>
      <ArchitectureDiagram
        arch={arch}
        projectId={projectId}
        selected={selected}
        onSelect={(key) => onSelect(key === selected ? undefined : key)}
      />
      {arch.edges.length > 0 && (
        <details className="arch-list">
          <summary>Phụ thuộc dạng danh sách ({arch.edges.length})</summary>
          <ul>
            {arch.edges.map((e) => (
              <li key={`${e.from}>${e.to}>${e.capabilityId}`}>
                <b>{nameOf(e.from)}</b> cần{" "}
                <span className="mono" translate="no">
                  {e.capabilityId}
                </span>{" "}
                từ <b>{nameOf(e.to)}</b>
              </li>
            ))}
          </ul>
        </details>
      )}
    </>
  );
}

/**
 * Panel của một công cụ: trạng thái, drift, capability cung cấp, cần gì từ ai và ai cần nó — quan hệ
 * bằng CHỮ, nên dưới 860px (lớp cạnh ẩn) vẫn đủ thông tin. Bấm một quan hệ là chọn công cụ kia.
 */
function ToolPanel({
  arch,
  tool,
  projectId,
  onSelect,
}: {
  arch: ArchitectureWire;
  tool: ArchitectureToolWire;
  projectId: string;
  onSelect: (key: string | undefined) => void;
}) {
  const panel = useRef<HTMLElement>(null);
  const health = toolHealth(tool);
  const rel = relationsOf(arch, tool.key);

  useEffect(() => {
    try {
      if (window.matchMedia("(max-width: 860px)").matches)
        panel.current?.focus();
    } catch {
      // jsdom không có matchMedia
    }
  }, [tool.key]);

  const other = (r: (typeof rel.needs)[number]) =>
    r.tool === undefined ? (
      <span className="mono" translate="no">
        {r.key}
      </span>
    ) : (
      <button type="button" className="linkbtn" onClick={() => onSelect(r.key)}>
        {r.tool.displayName}
      </button>
    );

  return (
    <aside
      ref={panel}
      className="peek"
      aria-label={`Công cụ ${tool.displayName}`}
      tabIndex={-1}
    >
      <div className="ph">
        <b>{tool.displayName}</b>
        <button
          type="button"
          className="ib"
          aria-label="Đóng"
          style={{ marginLeft: "auto" }}
          onClick={() => onSelect(undefined)}
        >
          <Icon of={X} />
        </button>
      </div>
      <div className="inner">
        <dl className="props">
          <dt>Tool</dt>
          <dd className="mono" translate="no">
            {tool.toolId}
            {tool.adapterVersion !== null && ` ${tool.adapterVersion}`}
          </dd>
          <dt>Trạng thái</dt>
          <dd>
            <StatusLabel tone={health.tone}>{health.label}</StatusLabel>
          </dd>
          <dt>Drift</dt>
          <dd>
            {DRIFT_LABEL[tool.drift.verdict]}
            {tool.drift.at !== null && `, ${formatDateTime(tool.drift.at)}`}
          </dd>
          <dt>Phạm vi</dt>
          <dd>
            {tool.scope === null
              ? "Máy chủ không còn nạp tool này"
              : tool.scope === "cluster"
                ? "Cả cluster"
                : "Mỗi environment"}
          </dd>
          <dt>Thứ tự deploy</dt>
          <dd>
            {tool.tier === null ? "Chưa có" : `Bậc ${String(tool.tier + 1)}`}
          </dd>
        </dl>

        <div className="sect">
          <h3>Cung cấp</h3>
        </div>
        {tool.provides.length === 0 ? (
          <p className="c3">Không cung cấp capability nào cho tool khác.</p>
        ) : (
          <p className="chips">
            {tool.provides.map((c) => (
              <span key={c} className="chip soft mono" translate="no">
                {c}
              </span>
            ))}
          </p>
        )}

        <div className="sect">
          <h3>Cần</h3>
        </div>
        {rel.needs.length === 0 ? (
          <p className="c3">Không phụ thuộc tool nào.</p>
        ) : (
          <ul className="rel-list">
            {rel.needs.map((r) => (
              <li key={`${r.capabilityId}>${r.key}`}>
                <span className="mono" translate="no">
                  {r.capabilityId}
                </span>{" "}
                từ {other(r)}
              </li>
            ))}
          </ul>
        )}

        <div className="sect">
          <h3>Được dùng bởi</h3>
        </div>
        {rel.usedBy.length === 0 ? (
          <p className="c3">Chưa tool nào dùng capability của nó.</p>
        ) : (
          <ul className="rel-list">
            {rel.usedBy.map((r) => (
              <li key={`${r.capabilityId}<${r.key}`}>
                {other(r)} dùng{" "}
                <span className="mono" translate="no">
                  {r.capabilityId}
                </span>
              </li>
            ))}
          </ul>
        )}

        <Link
          to="/app/projects/$projectId/domains/$type"
          params={{ projectId, type: tool.domainType }}
          className="btn"
        >
          Mở trang domain
        </Link>
      </div>
    </aside>
  );
}
