import { Link } from "@tanstack/react-router";
import type {
  ArchitectureToolWire,
  ArchitectureWire,
} from "@udp/shared-types/wire";
import { Cloud, Lock, Network, Server } from "lucide-react";
import { useState } from "react";
import { Icon } from "../../components/Icon";
import { LinkLayer } from "../../components/LinkLayer";
import { StatusLabel } from "../../components/StatusLabel";
import { useMessages } from "../../i18n";
import { relativeTime } from "../../lib/format";
import { PROVIDER_LABEL } from "../project/cloud/cloud-labels";
import {
  namespaceTools,
  resourceKinds,
  tiersOf,
  toolHealth,
  WORKLOAD_TONE,
} from "./architecture-model";
import { architectureMessages } from "./architecture.messages";

/**
 * Sơ đồ kiến trúc (Plan #53 QĐ-7; DESIGN.md §6 "Sơ đồ kiến trúc"): khung LỒNG NHAU theo chứa đựng —
 * cloud ⊃ mạng ⊃ cluster ⊃ (công cụ cấp cluster theo bậc deploy) và (mỗi environment ⊃ workload và
 * công cụ cấp namespace). Mỗi tầng một sắc nền; cạnh phụ thuộc vẽ ở `LinkLayer`: nét mảnh từ công cụ tiêu
 * thụ tới công cụ cung cấp (mũi tên chỉ vào bên cung cấp: "cần").
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
  const m = useMessages(architectureMessages).diagram;
  // Callback ref qua state: lớp cạnh đo SAU khi khung đã gắn (xem `LinkLayer`)
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
              ? m.noCloud
              : `${PROVIDER_LABEL[arch.cloud.provider]} ${arch.cloud.region}`}
          </h2>
          {arch.cloud !== null && (
            <span className="chip soft">{arch.cloud.mode}</span>
          )}
        </header>
        <section className="arch-net" aria-labelledby="arch-net-h">
          <header className="arch-h">
            <Icon of={Network} />
            <h3 id="arch-net-h">{m.network}</h3>
            <Kinds kinds={network} empty={m.noNetwork} />
          </header>
          <section className="arch-cluster" aria-labelledby="arch-cluster-h">
            <header className="arch-h">
              <Icon of={Server} />
              <h3 id="arch-cluster-h">
                {arch.cluster === null
                  ? m.noCluster
                  : m.cluster(
                      <span className="mono" translate="no">
                        {arch.cluster.clusterId}
                      </span>,
                    )}
              </h3>
              <Kinds kinds={cluster} empty="" />
            </header>

            {tiers.length > 0 && (
              <div className="arch-tiers" aria-label={m.clusterTools}>
                {tiers.map((column) => (
                  <section
                    key={column.tier ?? "loose"}
                    className="arch-tier"
                    aria-label={
                      column.tier === null
                        ? m.outsideOrder
                        : m.tier(column.tier + 1)
                    }
                  >
                    <h4 className="arch-tier-h">
                      {column.tier === null
                        ? m.unordered
                        : m.tier(column.tier + 1)}
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
                      <span className="c3" title={m.production}>
                        <Icon of={Lock} size={12} />
                        <span className="visually-hidden">
                          {m.productionHidden}
                        </span>
                      </span>
                    )}
                    <span className="mono c3 arch-ns" translate="no">
                      {e.namespace}
                    </span>
                  </header>
                  {e.workloads.length === 0 ? (
                    <p className="c3 arch-empty">{m.noWorkloads}</p>
                  ) : (
                    <ul
                      className="arch-workloads"
                      aria-label={m.workloadsIn(e.name)}
                    >
                      {e.workloads.map((w) => (
                        <li key={w.name} className="arch-workload">
                          <span className="mono" translate="no">
                            {w.name}
                          </span>
                          <span className="mono c3" translate="no">
                            {w.imageTag ?? m.noTag}
                          </span>
                          <StatusLabel tone={WORKLOAD_TONE[w.lastEvent]}>
                            {m.workload[w.lastEvent]} {relativeTime(w.at)}
                          </StatusLabel>
                        </li>
                      ))}
                    </ul>
                  )}
                  {perNamespace.length > 0 && (
                    <ul
                      className="arch-nstools"
                      aria-label={m.namespaceTools(e.namespace)}
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
      <LinkLayer
        container={root}
        links={arch.edges.map((e) => ({
          id: `${e.from}>${e.to}>${e.capabilityId}`,
          from: e.from,
          to: e.to,
        }))}
        active={hover ?? selected}
        version={`${arch.generatedAt}:${String(arch.tools.length)}`}
        attr="tool"
        className="arch-edges"
      />
    </div>
  );
}

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
