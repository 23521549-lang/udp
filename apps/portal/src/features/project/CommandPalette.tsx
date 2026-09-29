import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import {
  ChartNoAxesColumnIncreasing,
  Flag,
  LayoutDashboard,
  Lock,
  Moon,
  Plus,
  Search,
  Settings2,
  Sun,
  Users,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { create } from "zustand";
import { appMessages } from "../../app/app.messages";
import { useTheme } from "../../app/theme";
import { Icon } from "../../components/Icon";
import { useMessages } from "../../i18n";
import { browserTimeZone } from "../../lib/format";
import { qk } from "../../lib/query-keys";
import { flagApi } from "../flag/flag-api";
import { rolloutApi } from "../rollout/rollout-api";
import { useProjectContext } from "./ProjectLayout";
import { projectMessages } from "./project.messages";
import { can } from "./roles";

/** [Plan #41] Số flag bảng lệnh xin mỗi lần, và thời gian chờ sau phím gõ cuối */
const PALETTE_FLAGS = 20;
const PALETTE_SEARCH_DEBOUNCE_MS = 250;

/**
 * Bảng lệnh Ctrl K (DESIGN.md §6, §7): tìm flag, rollout và lệnh; mũi tên chọn, Enter
 * chạy, Esc đóng. Cùng dữ liệu (và cùng query key) với trang Flag/Rollout, nên mở bảng
 * lệnh không tốn request nào khi trang kia đã nạp.
 *
 * Ctrl K không phải đường DUY NHẤT tới bảng: nút "Tìm nhanh" trên thanh bên mở cùng bảng
 * này, nên người dùng mà trình duyệt/trình đọc màn hình giữ Ctrl K vẫn tới được mọi lệnh.
 */

export interface PaletteItem {
  /** Tên nhóm đã dịch — các mục liền nhau cùng tên gộp thành một nhóm của listbox */
  group: string;
  label: string;
  hint: string;
  icon: LucideIcon;
  run: () => void;
}

/** Lọc không phân biệt hoa thường và dấu — gõ "thanh toan" tìm được "Thanh toán" */
export function matchItems(items: PaletteItem[], query: string): PaletteItem[] {
  const fold = (s: string) =>
    s.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/đ/gi, "d").toLowerCase();
  const q = fold(query.trim());
  return q === ""
    ? items
    : items.filter((i) => fold(`${i.label} ${i.hint}`).includes(q));
}

/** Phím đang gõ vào một ô nhập thì không phải phím tắt */
export function isTyping(target: EventTarget | null): boolean {
  const t = target as HTMLElement | null;
  return (
    t !== null &&
    (t.tagName === "INPUT" ||
      t.tagName === "TEXTAREA" ||
      t.tagName === "SELECT" ||
      t.isContentEditable)
  );
}

/** Mở/đóng dùng chung: phím Ctrl K (trong project) và nút "Tìm nhanh" (thanh bên) */
export const usePaletteStore = create<{
  open: boolean;
  setOpen: (v: boolean) => void;
}>()((set) => ({ open: false, setOpen: (open) => set({ open }) }));

export function useCtrlK(): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (
        (e.ctrlKey || e.metaKey) &&
        !e.altKey &&
        e.key.toLowerCase() === "k"
      ) {
        e.preventDefault();
        const s = usePaletteStore.getState();
        s.setOpen(!s.open);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);
}

/** Phím tắt của project + bảng lệnh — đặt BÊN TRONG ProjectContext */
export function ProjectKeyboard() {
  useCtrlK();
  useEnvShortcuts();
  const open = usePaletteStore((s) => s.open);
  const setOpen = usePaletteStore((s) => s.setOpen);
  return open ? <CommandPalette onClose={() => setOpen(false)} /> : null;
}

/**
 * Phím 1..9 đổi environment theo thứ tự `rank` (DESIGN.md §7). Không bắt khi đang gõ,
 * khi có hộp thoại, hay khi kèm phím bổ trợ — những lúc đó phím số là của người dùng.
 */
export function useEnvShortcuts(): void {
  const { envs, env, setEnv } = useProjectContext();
  useEffect(() => {
    const ordered = [...envs].sort((a, b) => a.rank - b.rank);
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey || isTyping(e.target)) return;
      if (document.querySelector("[role=dialog]")) return;
      if (!/^[1-9]$/.test(e.key)) return;
      const target = ordered[Number(e.key) - 1];
      if (target === undefined || target.id === env.id) return;
      e.preventDefault();
      setEnv(target.id);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [envs, env.id, setEnv]);
}

export function CommandPalette({ onClose }: { onClose: () => void }) {
  const m = useMessages(projectMessages).palette;
  const app = useMessages(appMessages);
  const { project, envs, env, setEnv } = useProjectContext();
  const navigate = useNavigate();
  const { theme, toggle } = useTheme();
  const [query, setQuery] = useState("");
  const [sel, setSel] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const tz = browserTimeZone();

  // [Plan #41] Flag tìm ở MÁY CHỦ theo chữ đang gõ (sau khi ngừng gõ), tối đa PALETTE_FLAGS —
  // project vài trăm flag không bị tải trọn chỉ để mở bảng lệnh
  const [term, setTerm] = useState("");
  useEffect(() => {
    const t = setTimeout(() => {
      setTerm(query.trim());
    }, PALETTE_SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [query]);
  const flags = useQuery({
    queryKey: qk.flags(project.id, env.id, "none", {
      term,
      limit: PALETTE_FLAGS,
    }),
    queryFn: () =>
      flagApi.page(project.id, env.id, tz, {
        search: term,
        limit: PALETTE_FLAGS,
      }),
    staleTime: 10_000,
    placeholderData: keepPreviousData,
  });
  const rollouts = useQuery({
    queryKey: qk.rollouts(project.id, env.id),
    queryFn: () => rolloutApi.list(project.id, env.id),
  });

  const items = useMemo<PaletteItem[]>(() => {
    const params = { projectId: project.id };
    const out: PaletteItem[] = [];
    for (const f of flags.data?.flags ?? []) {
      out.push({
        group: m.group.flag,
        label: f.key,
        hint: f.description ?? "",
        icon: Flag,
        run: () =>
          void navigate({
            to: "/app/projects/$projectId/flags",
            params,
            search: { env: env.id, flag: f.id },
          }),
      });
    }
    for (const r of rollouts.data?.rollouts ?? []) {
      out.push({
        group: m.group.rollout,
        label: r.flagKey ?? r.workloadName ?? r.id.slice(0, 8),
        hint: `${String(r.currentTrafficPercentage)}%`,
        icon: ChartNoAxesColumnIncreasing,
        run: () =>
          void navigate({
            to: "/app/projects/$projectId/rollouts/$rolloutId",
            params: { projectId: project.id, rolloutId: r.id },
            search: { env: env.id },
          }),
      });
    }
    if (can(project.myRole, "DEVELOPER")) {
      out.push({
        group: m.group.command,
        label: m.createFlag,
        hint: "C",
        icon: Plus,
        run: () =>
          void navigate({
            to: "/app/projects/$projectId/flags",
            params,
            search: { env: env.id, new: "1" },
          }),
      });
    }
    if (can(project.myRole, "MAINTAINER")) {
      out.push({
        group: m.group.command,
        label: m.createRollout,
        hint: "",
        icon: Plus,
        run: () =>
          void navigate({
            to: "/app/projects/$projectId/rollouts",
            params,
            search: { env: env.id, new: "1" },
          }),
      });
    }
    [...envs]
      .sort((a, b) => a.rank - b.rank)
      .forEach((e, i) => {
        if (e.id === env.id) return;
        out.push({
          group: m.group.command,
          label: m.switchTo(e.name),
          hint: i < 9 ? String(i + 1) : "",
          icon: e.isProduction ? Lock : Search,
          run: () => setEnv(e.id),
        });
      });
    const page = (
      label: string,
      icon: LucideIcon,
      to:
        | "/app/projects/$projectId"
        | "/app/projects/$projectId/segments"
        | "/app/projects/$projectId/settings",
    ) =>
      out.push({
        group: m.group.command,
        label,
        hint: "",
        icon,
        run: () => void navigate({ to, params, search: { env: env.id } }),
      });
    page(m.openOverview, LayoutDashboard, "/app/projects/$projectId");
    page(m.openSegments, Users, "/app/projects/$projectId/segments");
    page(m.openSettings, Settings2, "/app/projects/$projectId/settings");
    out.push({
      group: m.group.command,
      label: theme === "dark" ? app.quickLightTheme : app.quickDarkTheme,
      hint: "",
      icon: theme === "dark" ? Sun : Moon,
      run: toggle,
    });
    return out;
  }, [
    flags.data,
    rollouts.data,
    project,
    envs,
    env.id,
    setEnv,
    navigate,
    theme,
    toggle,
    m,
    app,
  ]);

  const shown = matchItems(items, query);
  const current = Math.min(sel, Math.max(0, shown.length - 1));
  /** Các đoạn liên tiếp cùng nhóm — mỗi đoạn là một `role="group"` có tên trong listbox */
  const sections = shown.reduce<
    { group: string; start: number; items: typeof shown }[]
  >((acc, item, i) => {
    const last = acc[acc.length - 1];
    if (last !== undefined && last.group === item.group) last.items.push(item);
    else acc.push({ group: item.group, start: i, items: [item] });
    return acc;
  }, []);

  /*
   * Bảng lệnh là hộp thoại: Tab không được lọt ra trang phía sau (focus ở lại ô gõ — các lựa chọn đi
   * bằng mũi tên), và đóng lại thì focus về đúng chỗ đã mở nó.
   */
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    return () => {
      if (opener !== null && document.contains(opener)) opener.focus();
    };
  }, []);

  const runAt = (i: number) => {
    const item = shown[i];
    if (item === undefined) return;
    onClose();
    item.run();
  };

  useEffect(() => {
    try {
      listRef.current
        ?.querySelector('[aria-selected="true"]')
        ?.scrollIntoView({ block: "nearest" });
    } catch {
      // jsdom không có scrollIntoView dù kiểu DOM nói có; trình duyệt thật thì có
    }
  }, [current]);

  return (
    <>
      <div className="scrim on" onClick={onClose} aria-hidden="true" />
      <div
        className="pal on"
        role="dialog"
        aria-modal="true"
        aria-label={m.title}
        onKeyDown={(e) => {
          if (e.key === "Tab") e.preventDefault();
        }}
      >
        <div className="in">
          <Icon of={Search} />
          <input
            autoFocus
            role="combobox"
            aria-expanded="true"
            aria-controls="palette-list"
            aria-activedescendant={
              shown.length > 0 ? `pal-${String(current)}` : undefined
            }
            aria-label={m.search}
            placeholder={m.searchPlaceholder}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setSel(0);
            }}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setSel(Math.min(shown.length - 1, current + 1));
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                setSel(Math.max(0, current - 1));
              } else if (e.key === "Enter") {
                e.preventDefault();
                runAt(current);
              } else if (e.key === "Escape") {
                e.preventDefault();
                onClose();
              }
            }}
          />
          <kbd>{m.esc}</kbd>
        </div>
        <div
          className="ls"
          id="palette-list"
          role="listbox"
          aria-label={m.results}
          ref={listRef}
        >
          {shown.length === 0 && (
            <div className="gl" role="status">
              {m.noResults}
            </div>
          )}
          {sections.map((section) => {
            const headId = `pal-g-${String(section.start)}`;
            return (
              <div key={headId} role="group" aria-labelledby={headId}>
                <div className="gl" id={headId} aria-hidden="true">
                  {section.group}
                </div>
                {section.items.map((item, k) => {
                  const i = section.start + k;
                  return (
                    /*
                     * Lựa chọn của combobox: focus ở lại ô gõ (aria-activedescendant), bàn phím đi
                     * bằng mũi tên và Enter ở ô gõ — lựa chọn không là nút riêng để Tab dừng lại.
                     */
                    <div
                      key={`${item.label}-${String(i)}`}
                      id={`pal-${String(i)}`}
                      className="op"
                      role="option"
                      aria-selected={i === current}
                      onMouseMove={() => setSel(i)}
                      onClick={() => runAt(i)}
                    >
                      <Icon of={item.icon} />
                      <span>{item.label}</span>
                      <span className="h">
                        {item.hint.length > 0 && item.hint.length < 3 ? (
                          <kbd>{item.hint}</kbd>
                        ) : (
                          item.hint
                        )}
                      </span>
                    </div>
                  );
                })}
              </div>
            );
          })}
        </div>
        <div className="ft">
          <span>
            <kbd>↑</kbd>
            <kbd>↓</kbd> {m.select}
          </span>
          <span>
            <kbd>{m.enter}</kbd> {m.open}
          </span>
        </div>
      </div>
    </>
  );
}
