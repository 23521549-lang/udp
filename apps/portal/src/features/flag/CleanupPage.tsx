import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { StaleFlagsResponseWire } from "@udp/shared-types/wire";
import { Archive, Brush } from "lucide-react";
import { useState } from "react";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { Icon } from "../../components/Icon";
import { Empty, ErrorState, Loading } from "../../components/States";
import { toast } from "../../components/Toast";
import { messageOf } from "../../lib/errors";
import { compactNumber, relativeTime } from "../../lib/format";
import { qk, qkPrefix } from "../../lib/query-keys";
import { ProjectBar } from "../project/ProjectBar";
import { useProjectContext } from "../project/ProjectLayout";
import { can } from "../project/roles";
import { flagApi } from "./flag-api";

type Category = "UNUSED" | "SETTLED" | "STALE_DRAFT";

const CATEGORY: Record<Category, { label: string; hint: string }> = {
  UNUSED: {
    label: "Không dùng",
    hint: "Không lượt đánh giá nào trong cửa sổ quan sát.",
  },
  SETTLED: {
    label: "Đã ngã ngũ",
    hint: "Mọi lượt đều nhận cùng một variant: có thể xoá khỏi mã.",
  },
  STALE_DRAFT: {
    label: "Nháp bị bỏ quên",
    hint: "Nháp lâu ngày chưa kích hoạt.",
  },
};

/** §6.7 Flag Cleanup Center: tối đa 20 flag mỗi lô, xác nhận bằng TÊN PROJECT (§10.12) */
const MAX_BATCH = 20;

export function CleanupPage() {
  const { project } = useProjectContext();
  const queryClient = useQueryClient();
  const [category, setCategory] = useState<Category | undefined>(undefined);
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
      toast.info(
        failed === 0
          ? `Đã lưu trữ ${String(ok)} flag`
          : `Đã lưu trữ ${String(ok)} flag, ${String(failed)} flag không lưu trữ được`,
      );
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
        title="Dọn dẹp flag"
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
              Lưu trữ {picked.size > 0 ? picked.size : ""}
            </button>
          )
        }
      />
      <div className="scroll">
        <div className="mhead">
          <span className="tile xl">
            <Icon of={Brush} size={21} />
          </span>
          <div>
            <h1>Dọn dẹp flag</h1>
            <p>Flag không còn tác dụng là nợ trong mã. Gộp mọi environment.</p>
          </div>
        </div>
        <div className="filters">
          <div className="seg" role="group" aria-label="Loại">
            <button
              type="button"
              aria-pressed={category === undefined}
              onClick={() => setCategory(undefined)}
            >
              Tất cả {stale.data ? `(${String(stale.data.total)})` : ""}
            </button>
            {(Object.keys(CATEGORY) as Category[]).map((c) => (
              <button
                key={c}
                type="button"
                aria-pressed={category === c}
                onClick={() => setCategory(c)}
              >
                {CATEGORY[c].label}{" "}
                {stale.data ? `(${String(stale.data.counts[c])})` : ""}
              </button>
            ))}
          </div>
        </div>
        <div className="page">
          {stale.data?.telemetry.firstReportAt === null && (
            <p className="c3">
              Project chưa nhận báo cáo telemetry nào từ SDK, nên chưa xét được
              "Không dùng" và "Đã ngã ngũ".
            </p>
          )}
          {stale.isPending ? (
            <Loading />
          ) : stale.isError ? (
            <ErrorState
              error={stale.error}
              onRetry={() => void stale.refetch()}
            />
          ) : items.length === 0 ? (
            <Empty title="Không có flag nào cần dọn" />
          ) : (
            <div className="lst">
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
            <p className="c3">Tối đa {MAX_BATCH} flag mỗi lần lưu trữ.</p>
          )}
        </div>
      </div>
      {confirming && (
        <ConfirmDialog
          title={`Lưu trữ ${String(picked.size)} flag?`}
          description="SDK sẽ không còn nhận những flag này. Mỗi flag được lưu trữ riêng: flag nào còn lượt đánh giá sẽ được báo lại."
          confirmLabel="Lưu trữ"
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
  const id = `stale-${item.flag.id}`;
  return (
    <div className="it">
      <input
        id={id}
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={onToggle}
      />
      <label htmlFor={id} className="mono">
        {item.flag.key}
      </label>
      <span className="chip soft">{CATEGORY[item.category].label}</span>
      <span className="c3">{CATEGORY[item.category].hint}</span>
      <span className="c3 num" style={{ marginLeft: "auto" }}>
        {compactNumber(item.evalCount30d)} lượt/30 ngày
      </span>
      <span className="c3">
        {item.lastEvaluatedAt === null
          ? "chưa từng"
          : relativeTime(item.lastEvaluatedAt)}
      </span>
      {!item.archive.allowed && (
        <span className="c3">
          {item.archive.blockedBy === "LIVE_ROLLOUT"
            ? "đang có rollout"
            : "còn lượt gần đây"}
        </span>
      )}
    </div>
  );
}
