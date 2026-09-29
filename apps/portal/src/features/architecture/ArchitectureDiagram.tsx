import { Link } from "@tanstack/react-router";
import type {
  ArchitectureToolWire,
  ArchitectureWire,
} from "@udp/shared-types/wire";
import { Cloud, Lock, Network, Server } from "lucide-react";
import { useState } from "react";
import { Icon } from "../../components/Icon";
import { StatusLabel, type Tone } from "../../components/StatusLabel";
import { relativeTime } from "../../lib/format";
import { PROVIDER_LABEL } from "../project/cloud/cloud-labels";
import {
  namespaceTools,
  resourceKinds,
  tiersOf,
  toolHealth,
} from "./architecture-model";
import { EdgeLayer } from "./EdgeLayer";

/**
 * Sơ đồ kiến trúc (Plan #53 QĐ-7; DESIGN.md §6 "Sơ đồ kiến trúc"): khung LỒNG NHAU theo chứa đựng —
 * cloud ⊃ mạng ⊃ cluster ⊃ (công cụ cấp cluster theo bậc deploy) và (mỗi environment ⊃ workload và
 * công cụ cấp namespace). Mỗi tầng một sắc nền; cạnh phụ thuộc vẽ ở `EdgeLayer`.
 *
 * Cấu trúc là danh sách có tiêu đề — trình đọc màn hình đi qua nó như một cây; mỗi công cụ là một nút
 * (bàn phím chọn được), quan hệ bằng chữ ở panel. Không thư viện đồ thị: cấu trúc là một cây, cạnh chỉ
 * nối giữa các công cụ, nên layout là việc của CSS grid.
 */
export function ArchitectureDiagram({
  arch,
  projectId,
  selected,
  onSelect,
}: {
  arch: ArchitectureWire;
  projectId: string;
  selected: string | undefined;
  onSelect: (key: string) => void;
}) {
  // Callback ref qua state: lớp cạnh đo SAU khi khung đã gắn (xem `EdgeLayer`)
  const [root, setRoot] = useState<HTMLDivElement | null>(null);
  const [hover, setHover] = useState<string | undefined>(undefined);
  const tiers = tiersOf(arch.tools);
  const perNamespace = namespaceTools(arch.tools);
  const network = resourceKinds(arch, "NETWORK");
  const cluster = resourceKinds(arch, "CLUSTER");

  const node = (t: ArchitectureToolWire) => (
    <ToolNode
      tool={t}
      selected={selected === t.key}
      onSelect={() => onSelect(t.key)}
      onHover={(on) => setHover(on ? t.key : undefined)}
    />
  );

  return (
    <div className="arch" ref={setRoot}>
      <section className="arch-cloud" aria-labelledby="arch-cloud-h">
        <header className="arch-h">
          <Icon of={Cloud} />
          <h2 id="arch-cloud-h">
            {arch.cloud === null
              ? "Chưa kết nối cloud"
              : `${PROVIDER_LABEL[arch.cloud.provider]} ${arch.cloud.region}`}
          </h2>
          {arch.cloud !== null && (
            <span className="chip soft">{arch.cloud.mode}</span>
          )}
        </header>
        <section className="arch-net" aria-labelledby="arch-net-h">
          <header className="arch-h">
            <Icon of={Network} />
            <h3 id="arch-net-h">Mạng</h3>
            <Kinds kinds={network} empty="Chưa dựng mạng" />
          </header>
          <section className="arch-cluster" aria-labelledby="arch-cluster-h">
            <header className="arch-h">
              <Icon of={Server} />
              <h3 id="arch-cluster-h">
                {arch.cluster === null ? (
                  "Chưa có cluster"
                ) : (
                  <>
                    Cluster{" "}
                    <span className="mono" translate="no">
                      {arch.cluster.clusterId}
                    </span>
                  </>
                )}
              </h3>
              <Kinds kinds={cluster} empty="" />
            </header>

            {tiers.length > 0 && (
              <div
                className="arch-tiers"
                aria-label="Công cụ cấp cluster theo thứ tự deploy"
              >
                {tiers.map((column) => (
                  <section
                    key={column.tier ?? "loose"}
                    className="arch-tier"
                    aria-label={
                      column.tier === null
                        ? "Ngoài thứ tự deploy"
                        : `Bậc ${String(column.tier + 1)}`
                    }
                  >
                    <h4 className="arch-tier-h">
                      {column.tier === null
                        ? "Ngoài thứ tự"
                        : `Bậc ${String(column.tier + 1)}`}
                    </h4>
                    <ul>
                      {column.tools.map((t) => (
                        <li key={t.key}>{node(t)}</li>
                      ))}
                    </ul>
                  </section>
                ))}
              </div>
            )}

            <div className="arch-envs">
              {arch.environments.map((e) => (
                <section
                  key={e.id}
                  className="arch-env"
                  aria-labelledby={`arch-env-${e.id}`}
                >
                  <header className="arch-h">
                    <h4 id={`arch-env-${e.id}`}>
                      <Link
                        to="/app/projects/$projectId"
                        params={{ projectId }}
                        search={{ env: e.id }}
                      >
                        {e.name}
                      </Link>
                    </h4>
                    {e.isProduction && (
                      <span className="c3" title="Production">
                        <Icon of={Lock} size={12} />
                        <span className="visually-hidden">production</span>
                      </span>
                    )}
                    <span className="mono c3 arch-ns" translate="no">
                      {e.namespace}
                    </span>
                  </header>
                  {e.workloads.length === 0 ? (
                    <p className="c3 arch-empty">
                      Chưa có workload nào deploy qua UDP.
                    </p>
                  ) : (
                    <ul
                      className="arch-workloads"
                      aria-label={`Workload ở ${e.name}`}
                    >
                      {e.workloads.map((w) => (
                        <li key={w.name} className="arch-workload">
                          <span className="mono" translate="no">
                            {w.name}
                          </span>
                          <span className="mono c3" translate="no">
                            {w.imageTag ?? "không tag"}
                          </span>
                          <StatusLabel tone={WORKLOAD_TONE[w.lastEvent]}>
                            {WORKLOAD_LABEL[w.lastEvent]} {relativeTime(w.at)}
                          </StatusLabel>
                        </li>
                      ))}
                    </ul>
                  )}
                  {perNamespace.length > 0 && (
                    <ul
                      className="arch-nstools"
                      aria-label={`Công cụ trong namespace ${e.namespace}`}
                    >
                      {perNamespace.map((t) => (
                        <li key={`${e.id}-${t.key}`}>{node(t)}</li>
                      ))}
                    </ul>
                  )}
                </section>
              ))}
            </div>
          </section>
        </section>
      </section>
      <EdgeLayer
        container={root}
        edges={arch.edges}
        active={hover ?? selected}
        version={`${arch.generatedAt}:${String(arch.tools.length)}`}
      />
    </div>
  );
}

const WORKLOAD_LABEL: Record<
  ArchitectureWire["environments"][number]["workloads"][number]["lastEvent"],
  string
> = {
  DEPLOY_PENDING: "Chờ duyệt",
  DEPLOY_START: "Đang deploy",
  DEPLOY_SUCCESS: "Đã deploy",
  DEPLOY_FAILURE: "Deploy lỗi",
  ROLLBACK: "Đã rollback",
};

const WORKLOAD_TONE: Record<keyof typeof WORKLOAD_LABEL, Tone> = {
  DEPLOY_PENDING: "warn",
  DEPLOY_START: "running",
  DEPLOY_SUCCESS: "ok",
  DEPLOY_FAILURE: "error",
  ROLLBACK: "warn",
};

function Kinds({ kinds, empty }: { kinds: [string, number][]; empty: string }) {
  if (kinds.length === 0) {
    return empty === "" ? null : <span className="c3">{empty}</span>;
  }
  return (
    <span className="arch-kinds">
      {kinds.map(([kind, n]) => (
        <span key={kind} className="chip soft mono" translate="no">
          {n > 1 ? `${String(n)} × ${kind}` : kind}
        </span>
      ))}
    </span>
  );
}

function ToolNode({
  tool,
  selected,
  onSelect,
  onHover,
}: {
  tool: ArchitectureToolWire;
  selected: boolean;
  onSelect: () => void;
  onHover: (on: boolean) => void;
}) {
  const health = toolHealth(tool);
  return (
    <button
      type="button"
      className="arch-tool"
      data-tool={tool.key}
      aria-pressed={selected}
      onClick={onSelect}
      onMouseEnter={() => onHover(true)}
      onMouseLeave={() => onHover(false)}
      onFocus={() => onHover(true)}
      onBlur={() => onHover(false)}
    >
      <b>{tool.displayName}</b>
      <span className="mono c3" translate="no">
        {tool.toolId}
      </span>
      <StatusLabel tone={health.tone}>{health.label}</StatusLabel>
    </button>
  );
}
