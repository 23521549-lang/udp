import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import type { FlagSummaryWire } from "@udp/shared-types/wire";
import { Brush, Flag, Plus, Search } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Icon } from "../../components/Icon";
import { ProgressRing } from "../../components/ProgressRing";
import { Empty, ErrorState, Loading } from "../../components/States";
import { browserTimeZone, compactNumber, relativeTime } from "../../lib/format";
import { qk } from "../../lib/query-keys";
import { ProjectBar } from "../project/ProjectBar";
import { useProjectContext } from "../project/ProjectLayout";
import { can } from "../project/roles";
import { CreateFlagDialog } from "./CreateFlagDialog";
import { flagApi } from "./flag-api";
import { LIFECYCLE_LABEL, LIFECYCLE_ORDER } from "./flag-labels";
import { FlagDetail } from "./FlagDetail";

/**
 * Trang Flag (§10.8, DESIGN.md §6 "Danh sách" + "Xem nhanh").
 *
 * Danh sách thuộc MỘT env (query key có `envId`, I38); flag đang mở nằm ở search param
 * `flag` nên deep-link được mà không cần route lồng. Tìm kiếm lọc trên cache — không gọi
 * thêm lần nào mỗi phím gõ.
 */
export function FlagsPage() {
  const { project, env } = useProjectContext();
  const search = useSearch({ from: "/app/projects/$projectId/flags" });
  const navigate = useNavigate();
  const tz = browserTimeZone();
  const [creating, setCreating] = useState(false);
  const [q, setQ] = useState(search.q ?? "");

  const flags = useQuery({
    queryKey: qk.flags(project.id, env.id, "stats"),
    queryFn: () => flagApi.list(project.id, env.id, tz),
    staleTime: 10_000,
  });

  const open = useCallback(
    (flagId: string | undefined) => {
      void navigate({
        to: ".",
        search: (prev: Record<string, unknown>) => {
          const { flag: _drop, ...rest } = prev;
          return flagId === undefined ? rest : { ...rest, flag: flagId };
        },
      });
    },
    [navigate],
  );

  const visible = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const list = flags.data?.flags ?? [];
    return needle === ""
      ? list
      : list.filter(
          (f) =>
            f.key.includes(needle) ||
            (f.description ?? "").toLowerCase().includes(needle),
        );
  }, [flags.data, q]);

  const ordered = useMemo(
    () =>
      LIFECYCLE_ORDER.flatMap((status) =>
        visible.filter((f) => f.lifecycleStatus === status),
      ),
    [visible],
  );

  const canCreate = can(project.myRole, "DEVELOPER");

  // Phím tắt (DESIGN.md §7): j/k lên xuống, Enter mở, c tạo flag
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (
        t !== null &&
        (t.tagName === "INPUT" ||
          t.tagName === "TEXTAREA" ||
          t.tagName === "SELECT" ||
          t.isContentEditable)
      ) {
        return;
      }
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (document.querySelector("[role=dialog]")) return;
      if (e.key === "c" && canCreate) {
        e.preventDefault();
        setCreating(true);
        return;
      }
      if (e.key !== "j" && e.key !== "k") return;
      e.preventDefault();
      const idx = ordered.findIndex((f) => f.id === search.flag);
      const next =
        e.key === "j"
          ? Math.min(ordered.length - 1, idx + 1)
          : Math.max(0, idx === -1 ? 0 : idx - 1);
      const target = ordered[next];
      if (target !== undefined) open(target.id);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [ordered, search.flag, open, canCreate]);

  const total = flags.data?.flags.length ?? 0;
  const enabled = flags.data?.flags.filter((f) => f.env?.isEnabled).length ?? 0;
  const drafts =
    flags.data?.flags.filter((f) => f.lifecycleStatus === "DRAFT").length ?? 0;

  return (
    <>
      <ProjectBar
        title="Flag"
        actions={
          <>
            <Link
              to="/app/projects/$projectId/flags/cleanup"
              params={{ projectId: project.id }}
              search={{ env: env.id }}
              className="btn"
            >
              <Icon of={Brush} />
              Dọn dẹp
            </Link>
            {canCreate && (
              <button
                type="button"
                className="btn pri"
                onClick={() => setCreating(true)}
              >
                <Icon of={Plus} />
                Tạo flag <kbd>C</kbd>
              </button>
            )}
          </>
        }
      />
      <div className="body">
        <div className="scroll">
          <div className="mhead">
            <span className="tile xl">
              <Icon of={Flag} size={21} />
            </span>
            <div>
              <h1>Flag</h1>
              <p>Bật, tắt và phân phối tính năng ở {env.name}.</p>
            </div>
            <div className="minis">
              <div>
                <b>{total}</b>
                <span>flag</span>
              </div>
              <div>
                <b>{enabled}</b>
                <span>đang bật</span>
              </div>
              <div>
                <b>{drafts}</b>
                <span>nháp</span>
              </div>
            </div>
          </div>
          <div className="filters">
            <label className="q">
              <Icon of={Search} />
              <input
                aria-label="Tìm flag"
                placeholder="Tìm theo key hoặc mô tả"
                value={q}
                onChange={(e) => setQ(e.target.value)}
              />
            </label>
          </div>
          {flags.isPending ? (
            <Loading />
          ) : flags.isError ? (
            <ErrorState
              error={flags.error}
              onRetry={() => void flags.refetch()}
            />
          ) : total === 0 ? (
            <Empty title="Chưa có flag nào">
              {canCreate && (
                <button
                  type="button"
                  className="btn pri"
                  onClick={() => setCreating(true)}
                >
                  Tạo flag đầu tiên
                </button>
              )}
            </Empty>
          ) : ordered.length === 0 ? (
            <Empty title="Không flag nào khớp">Thử từ khoá khác.</Empty>
          ) : (
            <div role="listbox" aria-label="Danh sách flag">
              {LIFECYCLE_ORDER.map((status) => {
                const group = ordered.filter(
                  (f) => f.lifecycleStatus === status,
                );
                if (group.length === 0) return null;
                return (
                  <div
                    key={status}
                    role="group"
                    aria-label={LIFECYCLE_LABEL[status]}
                  >
                    <div className="gh">
                      {LIFECYCLE_LABEL[status]}
                      <span className="n">{group.length}</span>
                    </div>
                    {group.map((f) => (
                      <FlagRow
                        key={f.id}
                        flag={f}
                        selected={f.id === search.flag}
                        onOpen={() => open(f.id)}
                      />
                    ))}
                  </div>
                );
              })}
            </div>
          )}
        </div>
        {search.flag !== undefined && (
          <FlagDetail flagId={search.flag} onClose={() => open(undefined)} />
        )}
      </div>
      {creating && (
        <CreateFlagDialog
          onClose={() => setCreating(false)}
          onCreated={(id) => {
            setCreating(false);
            open(id);
          }}
        />
      )}
    </>
  );
}

function FlagRow({
  flag,
  selected,
  onOpen,
}: {
  flag: FlagSummaryWire;
  selected: boolean;
  onOpen: () => void;
}) {
  const on = flag.env?.isEnabled === true;
  return (
    <div
      className="row"
      role="option"
      aria-selected={selected}
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onOpen();
        }
      }}
    >
      <ProgressRing
        percent={on ? 100 : 0}
        tone={flag.env?.isTracked ? "accent" : "muted"}
        dashed={flag.lifecycleStatus === "DRAFT"}
      />
      <span className="t mono">{flag.key}</span>
      <span className="k">{flag.description ?? ""}</span>
      <span className="envs">
        <span>
          <i className={on ? "pip on" : "pip"} aria-hidden />
          {on ? "Bật" : "Tắt"}
        </span>
      </span>
      <Sparkline values={flag.stats?.daily14 ?? []} />
      <span className="when num">
        {flag.stats === undefined ? "" : compactNumber(flag.stats.evalCount7d)}
      </span>
      <span className="when" title={flag.updatedAt}>
        {relativeTime(flag.updatedAt)}
      </span>
    </div>
  );
}

/** Đường xu hướng 14 ngày — số lượt đánh giá, không trục (DESIGN.md §6 "Danh sách") */
function Sparkline({ values }: { values: number[] }) {
  if (values.length < 2) return <span />;
  const max = Math.max(1, ...values);
  const w = 64;
  const h = 18;
  const step = w / (values.length - 1);
  const d = values
    .map(
      (v, i) =>
        `${i === 0 ? "M" : "L"}${(i * step).toFixed(1)},${(h - (v / max) * (h - 2) - 1).toFixed(1)}`,
    )
    .join(" ");
  return (
    <svg className="spark" width={w} height={h} aria-hidden="true">
      <path d={d} fill="none" stroke="var(--ink-3)" strokeWidth="1.25" />
    </svg>
  );
}
