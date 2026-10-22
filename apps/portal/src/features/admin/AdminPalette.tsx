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
import { useEffect, useState } from "react";
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
import { qk } from "../../lib/query-keys";
import { adminApi } from "./admin-api";
import { adminMessages } from "./admin.messages";
import { useProjectDirectory } from "./project-directory";

/** Người dùng tìm ở MÁY CHỦ theo chữ đang gõ, sau khi ngừng gõ — như bảng lệnh của Portal (Plan #41) */
const USER_SEARCH_MIN = 2;
const USER_SEARCH_DEBOUNCE_MS = 250;
const USER_RESULTS = 8;

/**
 * [Plan #58 UX-30] Ctrl K của Bảng điều khiển: tới mọi trang, mở panel của một project theo tên, tìm người dùng theo
 * email. Cùng phím, cùng nút "Tìm nhanh", cùng trạng thái mở/đóng (`usePaletteStore`) và [Plan #60 H4] cùng khuôn
 * `CommandPaletteView` với bảng lệnh của Portal; hai khung không bao giờ cùng mở.
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
        literal: true,
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
        literal: true,
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
    <CommandPaletteView
      idPrefix="admin-pal"
      items={matchItems(items, query)}
      query={query}
      onQuery={setQuery}
      onClose={onClose}
      searchLabel={m.search}
      placeholder={m.searchPlaceholder}
    />
  );
}
