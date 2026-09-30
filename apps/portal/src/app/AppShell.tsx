import { useQuery } from "@tanstack/react-query";
import { Link, useParams, useSearch } from "@tanstack/react-router";
import {
  Activity,
  Blocks,
  ChartNoAxesColumnIncreasing,
  FileCode2,
  Flag,
  FolderKanban,
  House,
  LayoutDashboard,
  Network,
  Rocket,
  Search,
  Server,
  Settings2,
  Users,
  UsersRound,
} from "lucide-react";
import { Icon } from "../components/Icon";
import { usePaletteStore } from "../features/project/CommandPalette";
import { projectApi } from "../features/project/project-api";
import { shortcut } from "../lib/keys";
import { qk } from "../lib/query-keys";
import { useMessages } from "../i18n";
import { appMessages } from "./app.messages";
import { NAV, NavBody, Shell } from "./Shell";

/**
 * Khung của Portal (developer, `/app` — DESIGN.md §4). Trong một project, thanh bên có các phân hệ
 * với icon Lucide đúng bảng DESIGN.md §5; ngoài project chỉ có danh sách project. Lối sang Bảng
 * điều khiển nền tảng nằm ở khu tài khoản của `Shell`, không ở đây.
 */
export function AppShell() {
  const params = useParams({ strict: false });
  const projectId = (params as { projectId?: string }).projectId;
  const m = useMessages(appMessages).portalNav;
  return (
    <Shell
      kind="portal"
      label={m.label}
      nav={
        projectId === undefined ? (
          <nav aria-label={m.sections}>
            <Link {...NAV} to="/app/home">
              <NavBody icon={House}>{m.home}</NavBody>
            </Link>
            <Link {...NAV} to="/app/projects" activeOptions={{ exact: true }}>
              <NavBody icon={FolderKanban}>{m.projects}</NavBody>
            </Link>
            <Link {...NAV} to="/app/teams">
              <NavBody icon={UsersRound}>{m.teams}</NavBody>
            </Link>
          </nav>
        ) : (
          <ProjectNav projectId={projectId} />
        )
      }
    />
  );
}

function ProjectNav({ projectId }: { projectId: string }) {
  const m = useMessages(appMessages).portalNav;
  const project = useQuery({
    queryKey: qk.project(projectId),
    queryFn: () => projectApi.get(projectId),
  });
  /** Đổi phân hệ GIỮ env đang chọn — người dùng không bị đẩy về env mặc định */
  const search: { env?: string } = useSearch({ strict: false });
  const keep = search.env === undefined ? {} : { env: search.env };
  const params = { projectId };
  const sub = { includeSearch: false } as const;
  return (
    <nav aria-label={m.projectSections}>
      <Link to="/app/home" className="nv">
        <NavBody icon={House}>{m.home}</NavBody>
      </Link>
      <Link to="/app/projects" className="nv">
        <NavBody icon={FolderKanban}>{m.allProjects}</NavBody>
      </Link>
      <Link to="/app/teams" className="nv">
        <NavBody icon={UsersRound}>{m.teams}</NavBody>
      </Link>
      <button
        type="button"
        className="searchbtn"
        onClick={() => usePaletteStore.getState().setOpen(true)}
      >
        <Icon of={Search} size={14} />
        {m.quickSearch}
        <kbd>{shortcut("K")}</kbd>
      </button>
      <div className="grp" translate="no">
        {project.data?.project.name ?? "Project"}
      </div>
      <Link
        {...NAV}
        to="/app/projects/$projectId"
        params={params}
        search={keep}
        activeOptions={{ exact: true, includeSearch: false }}
      >
        <NavBody icon={LayoutDashboard}>{m.overview}</NavBody>
      </Link>
      <Link
        {...NAV}
        to="/app/projects/$projectId/architecture"
        params={params}
        search={keep}
        activeOptions={sub}
      >
        <NavBody icon={Network}>{m.architecture}</NavBody>
      </Link>
      <Link
        {...NAV}
        to="/app/projects/$projectId/monitoring"
        params={params}
        search={keep}
        activeOptions={sub}
      >
        <NavBody icon={Activity}>{m.monitoring}</NavBody>
      </Link>
      <Link
        {...NAV}
        to="/app/projects/$projectId/flags"
        params={params}
        search={keep}
        activeOptions={sub}
      >
        <NavBody icon={Flag}>{m.flags}</NavBody>
      </Link>
      <Link
        {...NAV}
        to="/app/projects/$projectId/segments"
        params={params}
        search={keep}
        activeOptions={sub}
      >
        <NavBody icon={Users}>{m.segments}</NavBody>
      </Link>
      <Link
        {...NAV}
        to="/app/projects/$projectId/rollouts"
        params={params}
        search={keep}
        activeOptions={sub}
      >
        <NavBody icon={ChartNoAxesColumnIncreasing}>{m.rollouts}</NavBody>
      </Link>
      <Link
        {...NAV}
        to="/app/projects/$projectId/deployments"
        params={params}
        search={keep}
        activeOptions={sub}
      >
        <NavBody icon={Rocket}>{m.deployments}</NavBody>
      </Link>
      <Link
        {...NAV}
        to="/app/projects/$projectId/code"
        params={params}
        search={keep}
        activeOptions={sub}
      >
        <NavBody icon={FileCode2}>{m.code}</NavBody>
      </Link>
      <Link
        {...NAV}
        to="/app/projects/$projectId/domains"
        params={params}
        search={keep}
        activeOptions={sub}
      >
        <NavBody icon={Blocks}>{m.domains}</NavBody>
      </Link>
      <Link
        {...NAV}
        to="/app/projects/$projectId/infra"
        params={params}
        search={keep}
        activeOptions={sub}
      >
        <NavBody icon={Server}>{m.infra}</NavBody>
      </Link>
      <Link
        {...NAV}
        to="/app/projects/$projectId/settings"
        params={params}
        search={keep}
        activeOptions={sub}
      >
        <NavBody icon={Settings2}>{m.settings}</NavBody>
      </Link>
    </nav>
  );
}
