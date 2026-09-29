import { useQuery } from "@tanstack/react-query";
import {
  Outlet,
  useNavigate,
  useParams,
  useSearch,
} from "@tanstack/react-router";
import type {
  ProjectClusterWire,
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
import { useProjectStream } from "./project-stream";

interface ProjectContextValue {
  project: PublicProjectWire;
  envs: PublicEnvironmentWire[];
  /** Env đang chọn — luôn thuộc project này (xem `resolveEnv`) */
  env: PublicEnvironmentWire;
  setEnv: (envId: string) => void;
  /** [Plan #45] Địa chỉ cluster (§10.6) — `null` khi project chưa có cluster */
  cluster: ProjectClusterWire | null;
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
  useProjectStream(projectId);

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

  const { project, environments, cluster } = query.data;
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
      value={{ project, envs: environments, env, setEnv, cluster }}
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
  const trigger = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    // Esc đóng hộp và trả focus về nút đã mở nó — không để focus rơi về đầu trang
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      setOpen(false);
      trigger.current?.focus();
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
        ref={trigger}
        type="button"
        className="envsw"
        aria-expanded={open}
        aria-controls="env-pop"
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
          id="env-pop"
          className="envpop"
          style={{ position: "absolute", top: 32, left: 0 }}
        >
          <label className="q">
            <input
              autoFocus
              type="search"
              name="env-q"
              autoComplete="off"
              spellCheck={false}
              placeholder="Tìm environment…"
              aria-label="Tìm environment"
              value={q}
              onChange={(e) => setQ(e.target.value)}
            />
          </label>
          <div role="group" aria-label="Environment">
            {shown.length === 0 && (
              <p className="c3 envpop-empty" role="status">
                Không environment nào khớp “{q.trim()}”.
              </p>
            )}
            {shown.map((e) => (
              <button
                key={e.id}
                type="button"
                className="op"
                aria-current={e.id === env.id ? "true" : undefined}
                onClick={() => {
                  setEnv(e.id);
                  setOpen(false);
                  trigger.current?.focus();
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
