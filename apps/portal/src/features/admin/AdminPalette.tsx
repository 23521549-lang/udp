import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import {
  Blocks,
  FileChartColumn,
  FolderKanban,
  Gauge,
  KeyRound,
  ListX,
  Moon,
  Network,
  PiggyBank,
  Search,
  Sun,
  UserRound,
  Users,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { appMessages } from "../../app/app.messages";
import { useTheme } from "../../app/theme";
import { Icon } from "../../components/Icon";
import { useMessages } from "../../i18n";
import { qk } from "../../lib/query-keys";
import {
  matchItems,
  useCtrlK,
  usePaletteStore,
  type PaletteItem,
} from "../project/CommandPalette";
import { adminApi } from "./admin-api";
import { adminMessages } from "./admin.messages";
import { useProjectDirectory } from "./project-directory";

/** Người dùng tìm ở MÁY CHỦ theo chữ đang gõ, sau khi ngừng gõ — như bảng lệnh của Portal (Plan #41) */
const USER_SEARCH_MIN = 2;
const USER_SEARCH_DEBOUNCE_MS = 250;
const USER_RESULTS = 8;

/**
 * [Plan #58 UX-30] Ctrl K của Bảng điều khiển: tới mọi trang, mở panel của một project theo tên, tìm người dùng theo
 * email. Cùng phím, cùng nút "Tìm nhanh" và cùng trạng thái mở/đóng (`usePaletteStore`) với bảng lệnh của Portal;
 * hai khung không bao giờ cùng mở.
 */
export function AdminKeyboard() {
  useCtrlK();
  const open = usePaletteStore((s) => s.open);
  const setOpen = usePaletteStore((s) => s.setOpen);
  return open ? <AdminPalette onClose={() => setOpen(false)} /> : null;
}

type ConsolePage =
  | "/admin/overview"
  | "/admin/jobs"
  | "/admin/orphans"
  | "/admin/architecture"
  | "/admin/users"
  | "/admin/projects"
  | "/admin/credentials"
  | "/admin/catalog"
  | "/admin/evidence";

function AdminPalette({ onClose }: { onClose: () => void }) {
  const m = useMessages(adminMessages).palette;
  const app = useMessages(appMessages);
  const nav = app.consoleNav;
  const navigate = useNavigate();
  const { theme, toggle } = useTheme();
  const [query, setQuery] = useState("");
  const [term, setTerm] = useState("");
  useEffect(() => {
    const t = setTimeout(() => setTerm(query.trim()), USER_SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [query]);
  const searching = term.length >= USER_SEARCH_MIN;
  const users = useQuery({
    queryKey: qk.adminUsers({ search: term === "" ? undefined : term }, 0),
    queryFn: () => adminApi.users({ search: term }, 0),
    enabled: searching,
    staleTime: 10_000,
    placeholderData: keepPreviousData,
  });
  const directory = useProjectDirectory();

  // Vài chục mục, dựng lại mỗi lần vẽ
  const page = (
    label: string,
    hint: string,
    icon: LucideIcon,
    to: ConsolePage,
  ): PaletteItem => ({
    group: m.group.page,
    label,
    hint,
    icon,
    run: () => void navigate({ to }),
  });
  const g = nav.groups;
  const items: PaletteItem[] = [
    page(nav.overview, g.operations, Gauge, "/admin/overview"),
    page(nav.jobs, g.operations, ListX, "/admin/jobs"),
    page(nav.orphans, g.operations, PiggyBank, "/admin/orphans"),
    page(nav.architecture, g.operations, Network, "/admin/architecture"),
    page(nav.users, g.customers, Users, "/admin/users"),
    page(nav.projects, g.customers, FolderKanban, "/admin/projects"),
    page(nav.credentials, g.customers, KeyRound, "/admin/credentials"),
    page(nav.catalog, g.reference, Blocks, "/admin/catalog"),
    page(nav.evidence, g.reference, FileChartColumn, "/admin/evidence"),
  ];
  if (query.trim() !== "") {
    for (const p of directory.byId.values()) {
      items.push({
        group: m.group.project,
        label: p.name,
        hint: p.owner.email,
        icon: FolderKanban,
        run: () =>
          void navigate({ to: "/admin/projects", search: { project: p.id } }),
      });
    }
  }
  if (searching) {
    for (const u of (users.data?.users ?? []).slice(0, USER_RESULTS)) {
      items.push({
        group: m.group.user,
        label: u.email,
        hint:
          u.platformRole === "PLATFORM_ADMIN"
            ? `${u.name} · ${m.admin}`
            : u.name,
        icon: UserRound,
        run: () =>
          void navigate({ to: "/admin/users", search: { q: u.email } }),
      });
    }
  }
  items.push({
    group: m.group.command,
    label: theme === "dark" ? app.quickLightTheme : app.quickDarkTheme,
    hint: "",
    icon: theme === "dark" ? Sun : Moon,
    run: toggle,
  });

  return (
    <PaletteView
      items={matchItems(items, query)}
      query={query}
      onQuery={setQuery}
      onClose={onClose}
    />
  );
}

/**
 * Hộp thoại combobox của bảng lệnh (DESIGN.md §6): ô gõ giữ focus, mũi tên chọn, Enter chạy, Esc đóng, Tab không lọt ra
 * trang phía sau, đóng thì trả focus. Cùng markup và lớp CSS với `CommandPalette` của Portal.
 */
function PaletteView({
  items,
  query,
  onQuery,
  onClose,
}: {
  items: PaletteItem[];
  query: string;
  onQuery: (q: string) => void;
  onClose: () => void;
}) {
  const m = useMessages(adminMessages).palette;
  const [sel, setSel] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const current = Math.min(sel, Math.max(0, items.length - 1));
  /** Các đoạn liên tiếp cùng nhóm — mỗi đoạn là một `role="group"` có tên trong listbox */
  const sections = items.reduce<
    { group: string; start: number; items: PaletteItem[] }[]
  >((acc, item, i) => {
    const last = acc[acc.length - 1];
    if (last !== undefined && last.group === item.group) last.items.push(item);
    else acc.push({ group: item.group, start: i, items: [item] });
    return acc;
  }, []);

  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    return () => {
      if (opener !== null && document.contains(opener)) opener.focus();
    };
  }, []);

  useEffect(() => {
    try {
      listRef.current
        ?.querySelector('[aria-selected="true"]')
        ?.scrollIntoView({ block: "nearest" });
    } catch {
      // jsdom không có scrollIntoView
    }
  }, [current]);

  const runAt = (i: number): void => {
    const item = items[i];
    if (item === undefined) return;
    onClose();
    item.run();
  };

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
            aria-controls="admin-palette-list"
            aria-activedescendant={
              items.length > 0 ? `admin-pal-${String(current)}` : undefined
            }
            aria-label={m.search}
            placeholder={m.searchPlaceholder}
            value={query}
            onChange={(e) => {
              onQuery(e.target.value);
              setSel(0);
            }}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setSel(Math.min(items.length - 1, current + 1));
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
          id="admin-palette-list"
          role="listbox"
          aria-label={m.results}
          ref={listRef}
        >
          {items.length === 0 && (
            <div className="gl" role="status">
              {m.noResults}
            </div>
          )}
          {sections.map((section) => {
            const headId = `admin-pal-g-${String(section.start)}`;
            return (
              <div key={headId} role="group" aria-labelledby={headId}>
                <div className="gl" id={headId} aria-hidden="true">
                  {section.group}
                </div>
                {section.items.map((item, k) => {
                  const i = section.start + k;
                  return (
                    <div
                      key={`${item.group}-${item.label}-${String(i)}`}
                      id={`admin-pal-${String(i)}`}
                      className="op"
                      role="option"
                      aria-selected={i === current}
                      onMouseMove={() => setSel(i)}
                      onClick={() => runAt(i)}
                    >
                      <Icon of={item.icon} />
                      <span
                        translate={
                          item.group === m.group.page ? undefined : "no"
                        }
                      >
                        {item.label}
                      </span>
                      <span className="h">{item.hint}</span>
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
