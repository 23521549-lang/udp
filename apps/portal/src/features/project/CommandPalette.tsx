import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import {
  ChartNoAxesColumnIncreasing,
  Flag,
  KeyRound,
  LayoutDashboard,
  Lock,
  Moon,
  Plus,
  Search,
  Settings2,
  Sun,
  UserPlus,
  Users,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { appMessages } from "../../app/app.messages";
import { useTheme } from "../../app/theme";
import {
  CommandPaletteView,
  matchItems,
  useCtrlK,
  usePaletteStore,
  type PaletteItem,
} from "../../components/CommandPalette";
import { useMessages } from "../../i18n";
import { browserTimeZone } from "../../lib/format";
import { qk } from "../../lib/query-keys";
import { useShortcutsEnabled } from "../../lib/shortcuts";
import { flagApi } from "../flag/flag-api";
import { rolloutApi } from "../rollout/rollout-api";
import { useProjectContext } from "./ProjectLayout";
import { projectMessages } from "./project.messages";
import { can } from "./roles";

/** [Plan #41] Số flag bảng lệnh xin mỗi lần, và thời gian chờ sau phím gõ cuối */
const PALETTE_FLAGS = 20;
const PALETTE_SEARCH_DEBOUNCE_MS = 250;

/**
 * Bảng lệnh Ctrl K của project (DESIGN.md §6, §7): tìm flag, rollout và lệnh. Cùng dữ liệu (và cùng query key) với
 * trang Flag/Rollout, nên mở bảng lệnh không tốn request nào khi trang kia đã nạp. Khuôn hộp thoại và bàn phím là
 * `CommandPaletteView` dùng chung với Bảng điều khiển (Plan #60 H4).
 */

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
 * [Plan #58 UX-40] Người dùng tắt phím tắt một phím thì không bắt gì cả (WCAG 2.1.4).
 */
export function useEnvShortcuts(): void {
  const { envs, env, setEnv } = useProjectContext();
  const enabled = useShortcutsEnabled();
  useEffect(() => {
    if (!enabled) return;
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
  }, [envs, env.id, setEnv, enabled]);
}

export function CommandPalette({ onClose }: { onClose: () => void }) {
  const m = useMessages(projectMessages).palette;
  const app = useMessages(appMessages);
  const { project, envs, env, setEnv } = useProjectContext();
  const navigate = useNavigate();
  const { theme, toggle } = useTheme();
  const shortcuts = useShortcutsEnabled();
  const [query, setQuery] = useState("");
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
        literal: true,
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
        literal: true,
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
        hint: "",
        shortcut: shortcuts ? "C" : undefined,
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
    // [Plan #58 UX-29] Hai việc chính của chủ sở hữu, tới thẳng từ Ctrl K
    if (can(project.myRole, "OWNER")) {
      const settings = (
        label: string,
        icon: LucideIcon,
        tab: "keys" | "members",
      ) =>
        out.push({
          group: m.group.command,
          label,
          hint: "",
          icon,
          run: () =>
            void navigate({
              to: "/app/projects/$projectId/settings",
              params,
              search: { env: env.id, tab, new: "1" },
            }),
        });
      settings(m.inviteMember, UserPlus, "members");
      settings(m.createSdkKey, KeyRound, "keys");
    }
    [...envs]
      .sort((a, b) => a.rank - b.rank)
      .forEach((e, i) => {
        if (e.id === env.id) return;
        out.push({
          group: m.group.command,
          label: m.switchTo(e.name),
          hint: "",
          shortcut: shortcuts && i < 9 ? String(i + 1) : undefined,
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
    shortcuts,
    m,
    app,
  ]);

  return (
    <CommandPaletteView
      idPrefix="pal"
      items={matchItems(items, query)}
      query={query}
      onQuery={setQuery}
      onClose={onClose}
      searchLabel={m.search}
      placeholder={m.searchPlaceholder}
    />
  );
}
