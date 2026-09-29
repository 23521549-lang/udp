import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useSearch } from "@tanstack/react-router";
import type { StaleFlagsResponseWire } from "@udp/shared-types/wire";
import { Archive } from "lucide-react";
import { useState } from "react";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { Icon } from "../../components/Icon";
import { Empty, ErrorState, Loading } from "../../components/States";
import { toast } from "../../components/Toast";
import { useMessages } from "../../i18n";
import { messageOf } from "../../lib/errors";
import { compactNumber, relativeTime } from "../../lib/format";
import { qk, qkPrefix } from "../../lib/query-keys";
import { ProjectBar } from "../project/ProjectBar";
import { useProjectContext } from "../project/ProjectLayout";
import { can } from "../project/roles";
import { flagApi } from "./flag-api";
import { flagMessages } from "./flag.messages";
import { PageHead } from "../../components/PageHead";

type Category = "UNUSED" | "SETTLED" | "STALE_DRAFT";

/** Thứ tự nút lọc; nhãn và gợi ý của mỗi loại ở `flagMessages.cleanup.category` */
const CATEGORIES: Category[] = ["UNUSED", "SETTLED", "STALE_DRAFT"];

/** §6.7 Flag Cleanup Center: tối đa 20 flag mỗi lô, xác nhận bằng TÊN PROJECT (§10.12) */
const MAX_BATCH = 20;

export function CleanupPage() {
  const m = useMessages(flagMessages).cleanup;
  const { project } = useProjectContext();
  const queryClient = useQueryClient();
  // Loại đang lọc nằm trên URL: gửi đường dẫn là gửi đúng danh sách đang xem
  const category = useSearch({
    from: "/app/projects/$projectId/flags/cleanup",
  }).category;
  const navigate = useNavigate();
  const setCategory = (c: Category | undefined): void => {
    void navigate({
      to: ".",
      search: (prev: Record<string, unknown>) => {
        const { category: _c, ...rest } = prev;
        return c === undefined ? rest : { ...rest, category: c };
      },
    });
  };
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [confirming, setConfirming] = useState(false);

  const stale = useQuery({
    queryKey: qk.staleFlags(project.id, category),
    queryFn: () => flagApi.stale(project.id, category),
  });

  const items = stale.data?.items ?? [];
  const archive = useMutation({
    mutationFn: (typed: string) =>
      flagApi.bulkArchive(
        project.id,
        items
          .filter((i) => picked.has(i.flag.id))
          .map((i) => ({
            flagId: i.flag.id,
            lastKnownUpdatedAt: i.flag.updatedAt,
          })),
        typed,
      ),
    onSuccess: async ({ results }) => {
      const ok = results.filter((r) => r.ok).length;
      const failed = results.length - ok;
      setConfirming(false);
      setPicked(new Set());
      toast.info(m.archived(ok, failed));
      await queryClient.invalidateQueries({
        queryKey: qkPrefix.staleFlagsOf(project.id),
      });
      await queryClient.invalidateQueries({
        queryKey: qkPrefix.flagsOf(project.id),
      });
    },
  });

  const toggle = (id: string) => {
    const next = new Set(picked);
    if (next.has(id)) next.delete(id);
    else if (next.size < MAX_BATCH) next.add(id);
    setPicked(next);
  };

  const canArchive = can(project.myRole, "MAINTAINER");

  return (
    <>
      <ProjectBar
        title={m.title}
        envScoped={false}
        actions={
          canArchive && (
            <button
              type="button"
              className="btn danger"
              disabled={picked.size === 0}
              onClick={() => setConfirming(true)}
            >
              <Icon of={Archive} />
              {m.archive} {picked.size > 0 ? picked.size : ""}
            </button>
          )
        }
      />
      <div className="scroll">
        <PageHead title={m.title} lead={m.lead} />
        <div className="filters">
          <div className="seg" role="group" aria-label={m.categoryGroup}>
            <button
              type="button"
              aria-pressed={category === undefined}
              onClick={() => setCategory(undefined)}
            >
              {m.all} {stale.data ? `(${String(stale.data.total)})` : ""}
            </button>
            {CATEGORIES.map((c) => (
              <button
                key={c}
                type="button"
                aria-pressed={category === c}
                onClick={() => setCategory(c)}
              >
                {m.category[c].label}{" "}
                {stale.data ? `(${String(stale.data.counts[c])})` : ""}
              </button>
            ))}
          </div>
        </div>
        <div className="page">
          {stale.data?.telemetry.firstReportAt === null && (
            <p className="c3">{m.noTelemetry}</p>
          )}
          {stale.isPending ? (
            <Loading />
          ) : stale.isError ? (
            <ErrorState
              error={stale.error}
              onRetry={() => void stale.refetch()}
            />
          ) : items.length === 0 ? (
            <Empty title={m.empty} />
          ) : (
            <div className="lst" role="list" aria-label={m.list}>
              {items.map((item) => (
                <StaleRow
                  key={item.flag.id}
                  item={item}
                  checked={picked.has(item.flag.id)}
                  disabled={!canArchive || !item.archive.allowed}
                  onToggle={() => toggle(item.flag.id)}
                />
              ))}
            </div>
          )}
          {picked.size >= MAX_BATCH && (
            <p className="c3">{m.maxBatch(MAX_BATCH)}</p>
          )}
        </div>
      </div>
      {confirming && (
        <ConfirmDialog
          title={m.confirmTitle(picked.size)}
          description={m.confirmDescription}
          confirmLabel={m.archive}
          danger
          typeToConfirm={project.name}
          busy={archive.isPending}
          error={archive.isError ? messageOf(archive.error) : undefined}
          onConfirm={(typed) => archive.mutate(typed ?? "")}
          onClose={() => {
            setConfirming(false);
            archive.reset();
          }}
        />
      )}
    </>
  );
}

function StaleRow({
  item,
  checked,
  disabled,
  onToggle,
}: {
  item: StaleFlagsResponseWire["items"][number];
  checked: boolean;
  disabled: boolean;
  onToggle: () => void;
}) {
  const m = useMessages(flagMessages).cleanup;
  // Cả dòng là nhãn của ô chọn: không có khoảng chết giữa ô và chữ (Web Interface Guidelines)
  return (
    <label className="it check-row" role="listitem">
      <input
        type="checkbox"
        name="flag"
        value={item.flag.id}
        checked={checked}
        disabled={disabled}
        onChange={onToggle}
      />
      <span className="mono" translate="no">
        {item.flag.key}
      </span>
      <span className="chip soft">{m.category[item.category].label}</span>
      <span className="c3">{m.category[item.category].hint}</span>
      <span className="c3 num" style={{ marginLeft: "auto" }}>
        {m.evals30d(compactNumber(item.evalCount30d), item.evalCount30d)}
      </span>
      <span className="c3">
        {item.lastEvaluatedAt === null
          ? m.never
          : relativeTime(item.lastEvaluatedAt)}
      </span>
      {!item.archive.allowed && (
        <span className="c3">
          {item.archive.blockedBy === "LIVE_ROLLOUT"
            ? m.liveRollout
            : m.recentEvals}
        </span>
      )}
    </label>
  );
}
