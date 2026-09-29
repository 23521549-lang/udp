import type {
  FlagDetailWire,
  FlagSummaryWire,
  ProjectDetailResponseWire,
} from "@udp/shared-types/wire";
import { http, HttpResponse } from "msw";
import { API, golden, server } from "./msw";

/** Project mẫu (golden `GET /projects/{id}`) với vai trò của người đang xem */
export function projectFixture(
  role: "OWNER" | "MAINTAINER" | "DEVELOPER" | "VIEWER",
): ProjectDetailResponseWire {
  const detail = golden<ProjectDetailResponseWire>("GET /projects/{id}");
  detail.project.myRole = role;
  return detail;
}

/** Ba lời gọi mà khung project luôn gửi: chi tiết, rollout đang chạy, thành viên */
export function useProjectHandlers(detail: ProjectDetailResponseWire): void {
  server.use(
    http.get(`${API}/projects/:id`, () => HttpResponse.json(detail)),
    http.get(`${API}/projects/:id/rollouts`, () =>
      HttpResponse.json({ rollouts: [] }),
    ),
    http.get(`${API}/projects/:id/members`, () =>
      HttpResponse.json(golden("GET /projects/{id}/members")),
    ),
    // [Plan #45] Thẻ "Deploy gần nhất" của Tổng quan
    http.get(`${API}/projects/:id/deployments/latest`, () =>
      HttpResponse.json(golden("GET /projects/{id}/deployments/latest")),
    ),
    // [Plan #53] Thẻ Cloud, lưới sức khoẻ và sơ đồ thu nhỏ của Tổng quan; ba con số flag ở đầu trang
    http.get(`${API}/projects/:id/architecture`, () =>
      HttpResponse.json(golden("GET /projects/{id}/architecture")),
    ),
    http.get(`${API}/projects/:id/flags`, () =>
      HttpResponse.json(golden("GET /projects/{id}/flags")),
    ),
  );
}

/** Một flag ACTIVE có cấu hình ở mọi env của project mẫu */
export function flagFixture(detail: ProjectDetailResponseWire): {
  flag: FlagDetailWire;
  summary: FlagSummaryWire;
} {
  const { flag } = golden<{ flag: FlagDetailWire }>(
    "GET /projects/{id}/flags/{id}",
  );
  flag.lifecycleStatus = "ACTIVE";
  const template = flag.envs[0];
  if (template === undefined) throw new Error("mẫu flag thiếu env");
  flag.envs = detail.environments.map((e, i) => ({
    ...template,
    environment: { id: e.id, name: e.name, isProduction: e.isProduction },
    configId: `${template.configId.slice(0, 35)}${String(i)}`,
    isEnabled: false,
  }));
  const summary: FlagSummaryWire = {
    id: flag.id,
    key: flag.key,
    flagType: flag.flagType,
    description: flag.description,
    lifecycleStatus: flag.lifecycleStatus,
    activatedAt: flag.activatedAt,
    updatedAt: flag.updatedAt,
    env: {
      configId: template.configId,
      isEnabled: false,
      isTracked: false,
      ruleCount: 0,
    },
  };
  return { flag, summary };
}
