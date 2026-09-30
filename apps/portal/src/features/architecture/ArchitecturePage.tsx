import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import type {
  ArchitectureToolWire,
  ArchitectureWire,
} from "@udp/shared-types/wire";
import { CircleAlert, X } from "lucide-react";
import { useRef, type RefObject } from "react";
import { Icon } from "../../components/Icon";
import { PageHead } from "../../components/PageHead";
import { Empty, ErrorState, Loading } from "../../components/States";
import { StatusLabel } from "../../components/StatusLabel";
import { useMessages } from "../../i18n";
import { InfoTip } from "../../components/InfoTip";
import { formatDateTime } from "../../lib/format";
import { usePeekFocus } from "../../lib/use-peek-focus";
import { qk } from "../../lib/query-keys";
import { driftLabel } from "../domain/domain-labels";
import { ProjectBar } from "../project/ProjectBar";
import { useProjectContext } from "../project/ProjectLayout";
import { ArchitectureDiagram } from "./ArchitectureDiagram";
import { architectureApi } from "./architecture-api";
import { healthSummary, relationsOf, toolHealth } from "./architecture-model";
import { architectureMessages } from "./architecture.messages";
import { SystemOverview } from "./SystemOverview";
import { systemMessages } from "./system.messages";

type View = "system" | "infra";
const VIEWS: readonly View[] = ["system", "infra"];

/**
 * Kiến trúc (Plan #53 QĐ-7): hệ thống UDP đã dựng cho project — cloud, mạng, cluster, environment,
 * workload và công cụ — cùng cạnh phụ thuộc tính bởi CHÍNH resolver đã chặn cấu hình sai (QĐ-3).
 * [Plan #57 QĐ-1] Hai góc nhìn: "Tổng quan hệ thống" (mặc định, C4 theo vai trò) và "Hạ tầng & công cụ"
 * (sơ đồ lồng nhau). Góc nhìn và công cụ đang chọn nằm trên URL (`?view=`, `?tool=`): gửi link là gửi đúng
 * chỗ đang xem.
 */
export function ArchitecturePage() {
  const m = useMessages(architectureMessages).page;
  const views = useMessages(systemMessages);
  const { project } = useProjectContext();
  const search = useSearch({ from: "/app/projects/$projectId/architecture" });
  const navigate = useNavigate({
    from: "/app/projects/$projectId/architecture",
  });
  const arch = useQuery({
    queryKey: qk.architecture(project.id),
    queryFn: () => architectureApi.get(project.id),
  });

  const view: View = search.view ?? "system";
  const show = (next: View): void => {
    void navigate({
      search: (prev) => {
        const { view: _drop, ...rest } = prev;
        return next === "system" ? rest : { ...rest, view: next };
      },
      replace: true,
    });
  };

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
  // [Plan #58 a11y] Mở panel thì focus vào panel, Esc đóng, đóng xong focus về đúng thẻ đã mở nó
  const panel = useRef<HTMLElement>(null);
  usePeekFocus(panel, selected?.key, () => select(undefined));

  return (
    <>
      <ProjectBar title={m.title} envScoped={false} />
      <div className="body">
        <div className="scroll">
          <PageHead
            title={m.title}
            lead={view === "system" ? views.lead : m.lead}
            minis={
              a === undefined || view === "system"
                ? undefined
                : [
                    { value: a.tools.length, label: m.tools(a.tools.length) },
                    {
                      value: a.environments.length,
                      label: m.environments(a.environments.length),
                    },
                    { value: workloads, label: m.workloads(workloads) },
                  ]
            }
          />
          <div className="page">
            <div
              className="envtabs"
              role="tablist"
              aria-label={views.views.label}
            >
              {VIEWS.map((v) => (
                <button
                  key={v}
                  type="button"
                  role="tab"
                  aria-selected={v === view}
                  onClick={() => show(v)}
                >
                  {views.views[v]}
                </button>
              ))}
            </div>
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
                view={view}
                selected={search.tool}
                onSelect={select}
              />
            )}
          </div>
        </div>
        {a !== undefined && selected !== undefined && (
          <ToolPanel
            panelRef={panel}
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
  view,
  selected,
  onSelect,
}: {
  arch: ArchitectureWire;
  projectId: string;
  view: View;
  selected: string | undefined;
  onSelect: (key: string | undefined) => void;
}) {
  const m = useMessages(architectureMessages).page;
  if (arch.cloud === null && arch.tools.length === 0) {
    // [Plan #58 UX-17] Vì sao trống, cần gì trước, và lối đi tiếp
    return (
      <Empty title={m.emptyTitle}>
        <p className="empty-why">{m.emptyBody}</p>
        <div className="empty-actions">
          <Link
            to="/app/projects/$projectId/settings"
            params={{ projectId }}
            search={{ tab: "cloud" }}
            className="btn pri"
          >
            {m.emptyCloud}
          </Link>
          <Link
            to="/app/projects/$projectId/domains"
            params={{ projectId }}
            className="btn"
          >
            {m.emptyDomains}
          </Link>
        </div>
      </Empty>
    );
  }
  const health = healthSummary(arch.tools);
  const byKey = new Map(arch.tools.map((t) => [t.key, t]));
  const nameOf = (key: string): string => byKey.get(key)?.displayName ?? key;
  const toggle = (key: string) => onSelect(key === selected ? undefined : key);
  return (
    <>
      {!arch.valid && (
        <div className="alert amber" role="status">
          <Icon of={CircleAlert} />
          <div>
            {m.invalid(
              <Link
                to="/app/projects/$projectId/domains"
                params={{ projectId }}
              >
                {m.invalidLink}
              </Link>,
            )}
          </div>
        </div>
      )}
      {view === "system" ? (
        <SystemOverview
          arch={arch}
          projectId={projectId}
          selected={selected}
          onSelect={toggle}
        />
      ) : (
        <>
          <p className="c3 arch-sum">
            {m.summary(
              arch.tools.length,
              health,
              formatDateTime(arch.generatedAt),
            )}
          </p>
          <ArchitectureDiagram
            arch={arch}
            projectId={projectId}
            selected={selected}
            onSelect={toggle}
          />
        </>
      )}
      {view === "infra" && arch.edges.length > 0 && (
        <details className="arch-list">
          <summary>{m.edgeList(arch.edges.length)}</summary>
          <ul>
            {arch.edges.map((e) => (
              <li key={`${e.from}>${e.to}>${e.capabilityId}`}>
                {m.edge(
                  <b>{nameOf(e.from)}</b>,
                  <span className="mono" translate="no">
                    {e.capabilityId}
                  </span>,
                  <b>{nameOf(e.to)}</b>,
                )}
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
  panelRef,
  arch,
  tool,
  projectId,
  onSelect,
}: {
  panelRef: RefObject<HTMLElement>;
  arch: ArchitectureWire;
  tool: ArchitectureToolWire;
  projectId: string;
  onSelect: (key: string | undefined) => void;
}) {
  const copy = useMessages(architectureMessages);
  const m = copy.panel;
  const health = toolHealth(tool);
  const rel = relationsOf(arch, tool.key);

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
      ref={panelRef}
      className="peek"
      aria-labelledby="arch-tool-h"
      tabIndex={-1}
    >
      <div className="ph">
        {/* [Plan #58 a11y] Tiêu đề của panel là heading: trình đọc màn hình nhảy tới được */}
        <h2 id="arch-tool-h" className="peek-h">
          {tool.displayName}
        </h2>
        <button
          type="button"
          className="ib"
          aria-label={m.close}
          style={{ marginLeft: "auto" }}
          onClick={() => onSelect(undefined)}
        >
          <Icon of={X} />
        </button>
      </div>
      <div className="inner">
        <dl className="props">
          <dt>
            {m.tool}
            <InfoTip term="tool" />
          </dt>
          <dd className="mono" translate="no">
            {tool.toolId}
            {tool.adapterVersion !== null && ` ${tool.adapterVersion}`}
          </dd>
          <dt>{m.status}</dt>
          <dd>
            <StatusLabel tone={health.tone}>{health.label}</StatusLabel>
          </dd>
          <dt>{m.drift}</dt>
          <dd>
            {driftLabel(tool.drift.verdict)}
            {tool.drift.at !== null && `, ${formatDateTime(tool.drift.at)}`}
          </dd>
          <dt>{m.scope}</dt>
          <dd>
            {tool.scope === null
              ? m.scopeGone
              : tool.scope === "cluster"
                ? m.scopeCluster
                : m.scopeNamespace}
          </dd>
          <dt>{m.order}</dt>
          <dd>
            {tool.tier === null ? m.noOrder : copy.diagram.tier(tool.tier + 1)}
          </dd>
        </dl>

        <div className="sect">
          <h3>{m.provides}</h3>
          <InfoTip term="capability" />
        </div>
        {tool.provides.length === 0 ? (
          <p className="c3">{m.providesNone}</p>
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
          <h3>{m.needs}</h3>
        </div>
        {rel.needs.length === 0 ? (
          <p className="c3">{m.needsNone}</p>
        ) : (
          <ul className="rel-list">
            {rel.needs.map((r) => (
              <li key={`${r.capabilityId}>${r.key}`}>
                {m.needsFrom(
                  <span className="mono" translate="no">
                    {r.capabilityId}
                  </span>,
                  other(r),
                )}
              </li>
            ))}
          </ul>
        )}

        <div className="sect">
          <h3>{m.usedBy}</h3>
        </div>
        {rel.usedBy.length === 0 ? (
          <p className="c3">{m.usedByNone}</p>
        ) : (
          <ul className="rel-list">
            {rel.usedBy.map((r) => (
              <li key={`${r.capabilityId}<${r.key}`}>
                {m.usedByItem(
                  other(r),
                  <span className="mono" translate="no">
                    {r.capabilityId}
                  </span>,
                )}
              </li>
            ))}
          </ul>
        )}

        <Link
          to="/app/projects/$projectId/domains/$type"
          params={{ projectId, type: tool.domainType }}
          className="btn"
        >
          {m.openDomain}
        </Link>
      </div>
    </aside>
  );
}
