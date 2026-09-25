import { useQuery } from "@tanstack/react-query";
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
import { useTheme } from "../../app/theme";
import { Icon } from "../../components/Icon";
import { browserTimeZone } from "../../lib/format";
import { qk } from "../../lib/query-keys";
import { flagApi } from "../flag/flag-api";
import { rolloutApi } from "../rollout/rollout-api";
import { useProjectContext } from "./ProjectLayout";
import { can } from "./roles";

/**
 * Bảng lệnh Ctrl K (DESIGN.md §6, §7): tìm flag, rollout và lệnh; mũi tên chọn, Enter
 * chạy, Esc đóng. Cùng dữ liệu (và cùng query key) với trang Flag/Rollout, nên mở bảng
 * lệnh không tốn request nào khi trang kia đã nạp.
 *
 * Ctrl K không phải đường DUY NHẤT tới bảng: nút "Tìm nhanh" trên thanh bên mở cùng bảng
 * này, nên người dùng mà trình duyệt/trình đọc màn hình giữ Ctrl K vẫn tới được mọi lệnh.
 */

export interface PaletteItem {
  group: "Flag" | "Rollout" | "Lệnh";
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
  const { project, envs, env, setEnv } = useProjectContext();
  const navigate = useNavigate();
  const { theme, toggle } = useTheme();
  const [query, setQuery] = useState("");
  const [sel, setSel] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const tz = browserTimeZone();

  const flags = useQuery({
    queryKey: qk.flags(project.id, env.id, "stats"),
    queryFn: () => flagApi.list(project.id, env.id, tz),
    staleTime: 10_000,
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
        group: "Flag",
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
        group: "Rollout",
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
        group: "Lệnh",
        label: "Tạo flag",
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
        group: "Lệnh",
        label: "Tạo rollout",
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
          group: "Lệnh",
          label: `Chuyển sang ${e.name}`,
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
        group: "Lệnh",
        label,
        hint: "",
        icon,
        run: () => void navigate({ to, params, search: { env: env.id } }),
      });
    page("Mở Tổng quan", LayoutDashboard, "/app/projects/$projectId");
    page("Mở Segment", Users, "/app/projects/$projectId/segments");
    page("Mở Cài đặt", Settings2, "/app/projects/$projectId/settings");
    out.push({
      group: "Lệnh",
      label: theme === "dark" ? "Giao diện sáng" : "Giao diện tối",
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
  ]);

  const shown = matchItems(items, query);
  const current = Math.min(sel, Math.max(0, shown.length - 1));

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
        aria-label="Tìm nhanh"
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
            aria-label="Tìm flag, rollout hoặc gõ lệnh"
            placeholder="Tìm flag, rollout hoặc gõ lệnh"
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
          <kbd>Esc</kbd>
        </div>
        <div className="ls" id="palette-list" role="listbox" ref={listRef}>
          {shown.length === 0 && <div className="gl">Không có kết quả</div>}
          {shown.map((item, i) => (
            <div key={`${item.group}-${item.label}-${String(i)}`}>
              {(i === 0 || shown[i - 1]?.group !== item.group) && (
                <div className="gl">{item.group}</div>
              )}
              <button
                type="button"
                id={`pal-${String(i)}`}
                className="op"
                role="option"
                aria-selected={i === current}
                tabIndex={-1}
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
              </button>
            </div>
          ))}
        </div>
        <div className="ft">
          <span>
            <kbd>↑</kbd>
            <kbd>↓</kbd> chọn
          </span>
          <span>
            <kbd>Enter</kbd> mở
          </span>
        </div>
      </div>
    </>
  );
}
