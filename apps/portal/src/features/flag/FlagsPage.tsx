import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import type { FlagSummaryWire } from "@udp/shared-types/wire";
import { Brush, Flag, Plus, Search } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Icon } from "../../components/Icon";
import { Pager } from "../../components/Pager";
import { ProgressRing } from "../../components/ProgressRing";
import { Empty, ErrorState, Loading } from "../../components/States";
import { Sparkline } from "../../components/Sparkline";
import {
  browserTimeZone,
  compactNumber,
  formatDateTime,
  relativeTime,
} from "../../lib/format";
import { qk } from "../../lib/query-keys";
import { useSearchInput } from "../../lib/use-search-input";
import { ProjectBar } from "../project/ProjectBar";
import { useProjectContext } from "../project/ProjectLayout";
import { can } from "../project/roles";
import { CreateFlagDialog } from "./CreateFlagDialog";
import { FLAG_PAGE_SIZE, flagApi } from "./flag-api";
import { useFlagCounts } from "./flag-counts";
import { LIFECYCLE_LABEL, LIFECYCLE_ORDER } from "./flag-labels";
import { FlagDetail } from "./FlagDetail";
import { PageHead } from "../../components/PageHead";

/**
 * Trang Flag (§10.8, DESIGN.md §6 "Danh sách" + "Xem nhanh").
 *
 * Danh sách thuộc MỘT env (query key có `envId`, I38); flag đang mở nằm ở search param
 * `flag` nên deep-link được mà không cần route lồng. [v4.11, Plan #41] Theo trang ở máy chủ
 * (`FLAG_PAGE_SIZE`): tìm kiếm gửi lên máy chủ sau khi ngừng gõ `SEARCH_DEBOUNCE_MS`, thanh số
 * đọc ba con số `total` — project vài trăm flag không bao giờ bị tải trọn.
 */
export function FlagsPage() {
  const { project, env } = useProjectContext();
  const search = useSearch({ from: "/app/projects/$projectId/flags" });
  const navigate = useNavigate();
  const tz = browserTimeZone();
  const [creating, setCreating] = useState(false);
  // `?new=1` (từ bảng lệnh): mở hộp tạo một lần rồi bỏ tham số, để Back không mở lại
  useEffect(() => {
    if (search.new !== "1") return;
    setCreating(true);
    void navigate({
      to: ".",
      replace: true,
      search: (prev: Record<string, unknown>) => {
        const { new: _drop, ...rest } = prev;
        return rest;
      },
    });
  }, [search.new, navigate]);
  // Từ khoá và trang nằm trên URL (Plan #53 QĐ-9); một lần tìm mới luôn bắt đầu từ trang đầu
  const term = (search.q ?? "").trim();
  const offset = search.offset ?? 0;
  const commitTerm = useCallback(
    (next: string) => {
      void navigate({
        to: ".",
        replace: true,
        search: (prev: Record<string, unknown>) => {
          const { q: _q, offset: _o, ...rest } = prev;
          return next === "" ? rest : { ...rest, q: next };
        },
      });
    },
    [navigate],
  );
  const [q, setQ] = useSearchInput(term, commitTerm);
  const setOffset = useCallback(
    (n: number) => {
      void navigate({
        to: ".",
        search: (prev: Record<string, unknown>) => {
          const { offset: _o, ...rest } = prev;
          return n === 0 ? rest : { ...rest, offset: n };
        },
      });
    },
    [navigate],
  );
  // Đổi env bắt đầu lại từ trang đầu: trang 3 của dev không phải trang 3 của prod
  const [seenEnv, setSeenEnv] = useState(env.id);
  if (seenEnv !== env.id) {
    setSeenEnv(env.id);
    if (offset !== 0) setOffset(0);
  }

  const flags = useQuery({
    queryKey: qk.flags(project.id, env.id, "stats", { term, offset }),
    queryFn: () =>
      flagApi.page(project.id, env.id, tz, {
        search: term,
        offset,
        stats: true,
      }),
    staleTime: 10_000,
    placeholderData: keepPreviousData,
  });
  const counts = useFlagCounts(project.id, env.id);

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

  const ordered = useMemo(
    () =>
      LIFECYCLE_ORDER.flatMap((status) =>
        (flags.data?.flags ?? []).filter((f) => f.lifecycleStatus === status),
      ),
    [flags.data],
  );
  const matched = flags.data?.total ?? 0;

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

  const total = counts.total ?? 0;

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
          <PageHead
            title="Flag"
            lead={<>Bật, tắt và phân phối tính năng ở {env.name}.</>}
            minis={[
              { value: counts.total ?? "–", label: "flag" },
              { value: counts.enabled ?? "–", label: "đang bật" },
              { value: counts.drafts ?? "–", label: "nháp" },
            ]}
          />
          <div className="filters">
            <label className="q">
              <Icon of={Search} />
              <input
                type="search"
                name="q"
                aria-label="Tìm flag"
                placeholder="Tìm theo key hoặc mô tả…"
                autoComplete="off"
                spellCheck={false}
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
          ) : total === 0 && term === "" ? (
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
            <>
              <div role="region" aria-label="Danh sách flag">
                <div className="row row-h" aria-hidden="true">
                  <span />
                  <span>Key</span>
                  <span className="k">Mô tả</span>
                  <span className="envs">Ở {env.name}</span>
                  <span className="spark-h">14 ngày</span>
                  <span className="when">Lượt 7 ngày</span>
                  <span className="when">Cập nhật</span>
                </div>
                {LIFECYCLE_ORDER.map((status) => {
                  const group = ordered.filter(
                    (f) => f.lifecycleStatus === status,
                  );
                  if (group.length === 0) return null;
                  const headId = `flag-group-${status}`;
                  return (
                    <section key={status} aria-labelledby={headId}>
                      <h2 className="gh" id={headId}>
                        {LIFECYCLE_LABEL[status]}
                        <span className="n">{group.length}</span>
                      </h2>
                      <div role="list">
                        {group.map((f) => (
                          <div role="listitem" key={f.id}>
                            <FlagRow flag={f} selected={f.id === search.flag} />
                          </div>
                        ))}
                      </div>
                    </section>
                  );
                })}
              </div>
              <Pager
                label="Trang của danh sách flag"
                offset={offset}
                pageSize={FLAG_PAGE_SIZE}
                total={matched}
                onChange={setOffset}
              />
            </>
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

/**
 * Một dòng flag là một LINK tới `?flag=<id>` (Plan #53 QĐ-9): Ctrl/Cmd-click mở tab mới đúng flag đó,
 * chuột giữa cũng vậy — trước đây là `div role="option"` chỉ mở được bằng một cú bấm trái.
 */
function FlagRow({
  flag,
  selected,
}: {
  flag: FlagSummaryWire;
  selected: boolean;
}) {
  const on = flag.env?.isEnabled === true;
  return (
    <Link
      to="."
      search={(prev: Record<string, unknown>) => ({ ...prev, flag: flag.id })}
      className="row"
      aria-current={selected ? "true" : undefined}
    >
      <ProgressRing
        percent={on ? 100 : 0}
        tone={flag.env?.isTracked ? "accent" : "muted"}
        dashed={flag.lifecycleStatus === "DRAFT"}
      />
      <span className="t mono" translate="no">
        {flag.key}
      </span>
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
      <span className="when" title={formatDateTime(flag.updatedAt)}>
        {relativeTime(flag.updatedAt)}
      </span>
    </Link>
  );
}
