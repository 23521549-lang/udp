import { useQuery } from "@tanstack/react-query";
import {
  Outlet,
  useNavigate,
  useParams,
  useSearch,
} from "@tanstack/react-router";
import type {
  PublicEnvironmentWire,
  PublicProjectWire,
} from "@udp/shared-types/wire";
import { Check, ChevronsUpDown, Lock } from "lucide-react";
import { createContext, useContext, useEffect, useRef, useState } from "react";
import { Icon } from "../../components/Icon";
import { ErrorState, Loading } from "../../components/States";
import { qk } from "../../lib/query-keys";
import { resolveEnv } from "./env";
import { useRolloutWatcher } from "../rollout/use-rollout-watcher";
import { ProjectKeyboard } from "./CommandPalette";
import { projectApi } from "./project-api";

interface ProjectContextValue {
  project: PublicProjectWire;
  envs: PublicEnvironmentWire[];
  /** Env đang chọn — luôn thuộc project này (xem `resolveEnv`) */
  env: PublicEnvironmentWire;
  setEnv: (envId: string) => void;
}

const ProjectContext = createContext<ProjectContextValue | null>(null);

/** Dùng trong mọi trang con của `/app/projects/$projectId` */
export function useProjectContext(): ProjectContextValue {
  const value = useContext(ProjectContext);
  if (value === null) {
    throw new Error("useProjectContext ngoài ProjectLayout");
  }
  return value;
}

export function ProjectLayout() {
  const { projectId } = useParams({ from: "/app/projects/$projectId" });
  const search = useSearch({ from: "/app/projects/$projectId" });
  const navigate = useNavigate();
  useRolloutWatcher(projectId);

  const query = useQuery({
    queryKey: qk.project(projectId),
    queryFn: () => projectApi.get(projectId),
    /** Project đang dựng hạ tầng thì hỏi lại mỗi 5s, xong thì thôi (§10.6) */
    refetchInterval: (q) =>
      q.state.data?.project.status === "PROVISIONING" ? 5_000 : false,
  });

  if (query.isPending) return <Loading />;
  if (query.isError) {
    return (
      <div className="page">
        <ErrorState error={query.error} onRetry={() => void query.refetch()} />
      </div>
    );
  }

  const { project, environments } = query.data;
  const env = resolveEnv(environments, search.env);
  if (env === undefined) {
    return (
      <div className="page">
        <ErrorState error={new Error("Project không có environment nào")} />
      </div>
    );
  }

  const setEnv = (envId: string) => {
    void navigate({
      to: ".",
      search: (prev: Record<string, unknown>) => ({ ...prev, env: envId }),
    });
  };

  return (
    <ProjectContext.Provider
      value={{ project, envs: environments, env, setEnv }}
    >
      <div
        className="project-frame"
        data-env-production={env.isProduction ? "true" : undefined}
      >
        <Outlet />
      </div>
      <ProjectKeyboard />
    </ProjectContext.Provider>
  );
}

/**
 * Bộ chọn môi trường trên thanh đầu trang (DESIGN.md §6, §10.12): tên + khoá cho
 * production + `chevrons-up-down`. Production luôn có khoá xám — người dùng phải biết
 * mình đang đứng ở đâu.
 */
export function EnvSwitcher() {
  const { envs, env, setEnv } = useProjectContext();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const shown = [...envs]
    .sort((a, b) => a.rank - b.rank)
    .filter((e) => e.name.toLowerCase().includes(q.trim().toLowerCase()));

  return (
    <div ref={ref} style={{ position: "relative" }}>
      <button
        type="button"
        className="envsw"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={`Environment: ${env.name}`}
        onClick={() => setOpen((v) => !v)}
      >
        {env.name}
        {env.isProduction && (
          <span className="lk" title="Production: mọi thay đổi cần xác nhận">
            <Icon of={Lock} size={12} />
          </span>
        )}
        <span className="ch">
          <Icon of={ChevronsUpDown} size={14} />
        </span>
      </button>
      {open && (
        <div
          className="envpop"
          style={{ position: "absolute", top: 32, left: 0 }}
        >
          <label className="q">
            <input
              autoFocus
              placeholder="Tìm environment"
              aria-label="Tìm environment"
              value={q}
              onChange={(e) => setQ(e.target.value)}
            />
          </label>
          <div role="listbox" aria-label="Environment">
            {shown.map((e) => (
              <button
                key={e.id}
                type="button"
                role="option"
                className="op"
                aria-selected={e.id === env.id}
                onClick={() => {
                  setEnv(e.id);
                  setOpen(false);
                }}
              >
                <span className="nm">
                  {e.name} {e.isProduction && <Icon of={Lock} size={12} />}
                  <small>
                    {e.isProduction
                      ? "Người dùng thật, cần xác nhận"
                      : `Namespace ${e.k8sNamespace}`}
                  </small>
                </span>
                <span className="r">
                  {e.id === env.id && <Icon of={Check} size={14} />}
                </span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
